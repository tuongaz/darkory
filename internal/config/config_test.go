package config

import (
	"io"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/blob"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadServe(t *testing.T) {
	cases := []struct {
		name string
		args []string
		env  map[string]string
		want Serve
	}{
		{"defaults", nil, nil, Serve{Listen: DefaultListen, Store: Store{".", filepath.Join(".", "darkory.db")},
			Evidence: blob.Settings{Dir: "evidence"}, SMTP: SMTP{MaxPerHour: 300}, EvidenceMaxMB: 100, SessionIdle: DefaultSessionIdle, SessionLifetime: DefaultSessionLifetime, MaxWaiting: DefaultMaxWaiting, Agents: "auto"}},
		{"environment", nil,
			map[string]string{"DARKORY_LISTEN": ":8080", "DARKORY_DATA": "/var/lib/darkory", "DARKORY_PUBLIC_URL": "https://dk.example.com",
				"DARKORY_NO_BROWSER": "1", "DARKORY_NO_LOGIN_LINK": "1", "DARKORY_DB": "postgres://pgbouncer/dk",
				"DARKORY_DB_LISTEN": "postgres://db/dk", "DARKORY_MIGRATE": "true", "DARKORY_PROXY_HOPS": "1",
				"DARKORY_EVIDENCE": "s3://bucket/install/1/", "DARKORY_S3_ENDPOINT": "http://minio:9000", "DARKORY_S3_ACCESS_KEY": "ak",
				"DARKORY_S3_SECRET_KEY": "sk", "DARKORY_S3_PATH_STYLE": "1", "DARKORY_EVIDENCE_MAX_MB": "20",
				"DARKORY_SMTP_URL": "smtp://u:p@mail:587", "DARKORY_SMTP_FROM": "Darkory <dk@example.com>", "DARKORY_SMTP_MAX_PER_HOUR": "50",
				"DARKORY_NO_UPDATE_CHECK": "yes", "DARKORY_SESSION_IDLE": "24h", "DARKORY_SESSION_LIFETIME": "168h", "DARKORY_MAX_WAITING": "4", "DARKORY_AGENTS": "off"},
			Serve{Listen: ":8080", Store: Store{"/var/lib/darkory", "postgres://pgbouncer/dk"}, PublicURL: "https://dk.example.com",
				NoBrowser: true, NoLoginLink: true, NoUpdateCheck: true, DatabaseListen: "postgres://db/dk", Migrate: true, ProxyHops: 1,
				Evidence: blob.Settings{S3: &blob.S3Settings{Bucket: "bucket", Prefix: "install/1", Endpoint: "http://minio:9000",
					Region: "us-east-1", AccessKey: "ak", SecretKey: "sk", PathStyle: true}},
				SMTP: SMTP{URL: "smtp://u:p@mail:587", From: "Darkory <dk@example.com>", MaxPerHour: 50}, EvidenceMaxMB: 20,
				SessionIdle: 24 * time.Hour, SessionLifetime: 168 * time.Hour, MaxWaiting: 4, Agents: "off"}},
		{"flags win", []string{"--listen", ":9000", "--db", "postgres://x/y", "--no-browser", "--no-login-link", "--migrate",
			"--proxy-hops", "2", "--evidence", "/srv/evidence", "--evidence-max-mb", "5", "--no-update-check",
			"--session-idle", "1h", "--session-lifetime", "2h", "--max-waiting", "2", "--agents=on"},
			map[string]string{"DARKORY_LISTEN": ":8080", "DARKORY_DB": "other.db", "DARKORY_PROXY_HOPS": "1", "DARKORY_EVIDENCE": "/elsewhere",
				"DARKORY_EVIDENCE_MAX_MB": "20", "DARKORY_NO_UPDATE_CHECK": "0", "DARKORY_SESSION_IDLE": "24h", "DARKORY_MAX_WAITING": "4",
				"DARKORY_AGENTS": "off"},
			Serve{Listen: ":9000", Store: Store{".", "postgres://x/y"}, NoBrowser: true, NoLoginLink: true, NoUpdateCheck: true, Migrate: true,
				ProxyHops: 2, Evidence: blob.Settings{Dir: "/srv/evidence"}, SMTP: SMTP{MaxPerHour: 300}, EvidenceMaxMB: 5,
				SessionIdle: time.Hour, SessionLifetime: 2 * time.Hour, MaxWaiting: 2, Agents: "on"}},
		{"DARKORY_NO_UPDATE_CHECK=false leaves the check on", nil, map[string]string{"DARKORY_NO_UPDATE_CHECK": "false"},
			Serve{Listen: DefaultListen, Store: Store{".", filepath.Join(".", "darkory.db")},
				Evidence: blob.Settings{Dir: "evidence"}, SMTP: SMTP{MaxPerHour: 300}, EvidenceMaxMB: 100, SessionIdle: DefaultSessionIdle, SessionLifetime: DefaultSessionLifetime, MaxWaiting: DefaultMaxWaiting, Agents: "auto"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := LoadServe(c.args, env(c.env), io.Discard)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
	if _, err := LoadServe([]string{"extra"}, env(nil), io.Discard); err == nil {
		t.Fatal("accepted a stray argument")
	}
	if _, err := LoadServe([]string{"--agents", "sometimes"}, env(nil), io.Discard); err == nil {
		t.Fatal("accepted --agents=sometimes")
	}
	if _, err := LoadServe([]string{"--evidence-max-mb", "0"}, env(nil), io.Discard); err == nil {
		t.Fatal("accepted an Evidence limit of nothing")
	}
}

func TestLoadServeRefusesIncompleteSettings(t *testing.T) {
	for _, c := range []struct {
		env  map[string]string
		want string
	}{
		{map[string]string{"DARKORY_SMTP_URL": "smtp://mail:587", "DARKORY_SMTP_FROM": "dk@example.com"}, "DARKORY_PUBLIC_URL"},
		{map[string]string{"DARKORY_SMTP_URL": "smtp://mail:587", "DARKORY_PUBLIC_URL": "https://dk.example.com"}, "DARKORY_SMTP_FROM"},
		{map[string]string{"DARKORY_EVIDENCE": "s3://bucket"}, "DARKORY_S3_ACCESS_KEY"},
		{map[string]string{"DARKORY_EVIDENCE": "s3://", "DARKORY_S3_ACCESS_KEY": "a", "DARKORY_S3_SECRET_KEY": "s"}, "s3://bucket"},
		{map[string]string{"DARKORY_EVIDENCE": "s3://b", "DARKORY_S3_ACCESS_KEY": "a", "DARKORY_S3_SECRET_KEY": "s",
			"DARKORY_S3_ENDPOINT": "minio:9000"}, "http://"},
		{map[string]string{"DARKORY_PROXY_HOPS": "-1"}, "DARKORY_PROXY_HOPS"},
		{map[string]string{"DARKORY_SMTP_MAX_PER_HOUR": "0"}, "DARKORY_SMTP_MAX_PER_HOUR"},
		{map[string]string{"DARKORY_SMTP_MAX_PER_HOUR": "lots"}, "DARKORY_SMTP_MAX_PER_HOUR"},
		{map[string]string{"DARKORY_SESSION_IDLE": "30"}, "DARKORY_SESSION_IDLE"},
		{map[string]string{"DARKORY_SESSION_LIFETIME": "0s"}, "--session-lifetime"},
		{map[string]string{"DARKORY_MAX_WAITING": "0"}, "--max-waiting"},
		{map[string]string{"DARKORY_MAX_WAITING": "many"}, "DARKORY_MAX_WAITING"},
	} {
		_, err := LoadServe(nil, env(c.env), io.Discard)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: got %v, want an error naming %s", c.env, err, c.want)
		}
	}
	// AWS's own variables stand in for the S3 keys and region.
	got, err := LoadServe(nil, env(map[string]string{"DARKORY_EVIDENCE": "s3://b", "AWS_ACCESS_KEY_ID": "a",
		"AWS_SECRET_ACCESS_KEY": "s", "AWS_REGION": "eu-west-2"}), io.Discard)
	if err != nil || got.Evidence.S3.AccessKey != "a" || got.Evidence.S3.SecretKey != "s" || got.Evidence.S3.Region != "eu-west-2" {
		t.Fatalf("got %+v, %v", got.Evidence.S3, err)
	}
}

func TestSignInModes(t *testing.T) {
	local, err := LoadServe(nil, env(nil), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if got := local.SignInModes(); !slices.Equal(got, []string{"printed_link"}) {
		t.Fatalf("Local signs in with %v", got)
	}
	emailed, err := LoadServe(nil, env(map[string]string{"DARKORY_SMTP_URL": "smtp://mail:587", "DARKORY_SMTP_FROM": "dk@example.com",
		"DARKORY_PUBLIC_URL": "https://dk.example.com"}), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if got := emailed.SignInModes(); !slices.Equal(got, []string{"printed_link", "email_link"}) {
		t.Fatalf("with SMTP, signs in with %v", got)
	}
}

func TestDatabaseListenURL(t *testing.T) {
	c := Serve{Store: Store{Database: "postgres://pgbouncer/dk"}}
	if got := c.DatabaseListenURL(); got != "postgres://pgbouncer/dk" {
		t.Fatalf("got %q", got)
	}
	c.DatabaseListen = "postgres://db/dk"
	if got := c.DatabaseListenURL(); got != "postgres://db/dk" {
		t.Fatalf("got %q", got)
	}
}

func TestLoadMigrate(t *testing.T) {
	got, err := LoadMigrate([]string{"--dry-run", "--data", "/d"}, env(nil), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if want := (Migrate{Store: Store{"/d", "/d/darkory.db"}, DryRun: true}); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	got, err = LoadMigrate(nil, env(map[string]string{"DARKORY_DB": "postgres://db/dk"}), io.Discard)
	if err != nil || got.Database != "postgres://db/dk" || got.DryRun {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestLoadInit(t *testing.T) {
	got, err := LoadInit([]string{"--org", "Acme", "--data", "/d"}, env(map[string]string{"USER": "ada"}), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	want := Init{Store: Store{"/d", "/d/darkory.db"}, Listen: DefaultListen, Org: "Acme", Name: "ada"}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	got, err = LoadInit([]string{"--no-agents", "--data", "/d"}, env(map[string]string{"USER": "ada"}), io.Discard)
	if err != nil || !got.NoAgents {
		t.Fatalf("--no-agents: %+v %v", got, err)
	}
}

func TestBaseURL(t *testing.T) {
	for _, c := range []struct{ public, listen, want string }{
		{"", "127.0.0.1:7357", "http://127.0.0.1:7357"},
		{"", ":8080", "http://127.0.0.1:8080"},
		{"", "0.0.0.0:80", "http://127.0.0.1:80"},
		{"https://dk.example.com", ":8080", "https://dk.example.com"},
	} {
		if got := BaseURL(c.public, c.listen); got != c.want {
			t.Errorf("BaseURL(%q, %q) = %q, want %q", c.public, c.listen, got, c.want)
		}
	}
}
