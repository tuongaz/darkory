package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/dockertest"
	"github.com/tuongaz/darkory/internal/mail"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// SMTPTestEnv runs the emailed sign-in round trip through Mailpit in Docker when set.
const SMTPTestEnv = "DARKORY_TEST_SMTP"

// Emailed sign-in through a real SMTP server: the link arrives in Mailpit's inbox and signs a
// browser in.
func TestEmailSignInThroughSMTP(t *testing.T) {
	// Mailpit looks up each SMTP client's address in DNS, which inside Docker can take ten seconds
	// to time out; the test does not need it.
	c := dockertest.Run(t, SMTPTestEnv, "axllent/mailpit:latest", []int{1025, 8025}, map[string]string{"MP_SMTP_DISABLE_RDNS": "true"})
	smtpAddr, api := c.Addr[0], "http://"+c.Addr[1]
	dockertest.WaitHTTP(t, api+"/readyz")
	sender, err := mail.NewSMTP("smtp://"+smtpAddr+"?tls=none", "Darkory <darkory@example.com>")
	if err != nil {
		t.Fatal(err)
	}
	h := newHarnessWith(t, storetest.Open(t, store.SQLite), Options{Mail: sender, PublicURL: publicURL})
	email := "bob@example.com"
	got(h.admin.CreateMemberWithResponse(t.Context(), &client.CreateMemberParams{},
		client.CreateMemberBody{Name: "bob", Kind: client.Human, Email: (*openapi_types.Email)(&email)})).want(t, http.StatusCreated)
	if s := askByEmail(t, h.ts, `{"email":"bob@example.com"}`, nil); s != http.StatusAccepted {
		t.Fatalf("status %d", s)
	}

	var list struct {
		Messages []struct {
			ID string
			To []struct{ Address string }
		}
	}
	deadline := time.Now().Add(30 * time.Second)
	for len(list.Messages) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("no email reached Mailpit")
		}
		time.Sleep(100 * time.Millisecond)
		getJSON(t, api+"/api/v1/messages", &list)
	}
	if len(list.Messages) != 1 || len(list.Messages[0].To) != 1 || list.Messages[0].To[0].Address != email {
		t.Fatalf("Mailpit holds %+v", list.Messages)
	}
	var msg struct {
		Subject string
		Text    string
	}
	getJSON(t, api+"/api/v1/message/"+list.Messages[0].ID, &msg)
	link := emailedLink.FindStringSubmatch(msg.Text)
	if msg.Subject != "Sign in to Darkory" || link == nil {
		t.Fatalf("received %+v", msg)
	}
	if res := redeem(t, h.ts, link[1]); res.StatusCode != http.StatusSeeOther || !strings.HasPrefix(res.Header.Get("Set-Cookie"), "darkory_session=") {
		t.Fatalf("redeeming the emailed link: %d", res.StatusCode)
	}
}

func getJSON(t *testing.T, url string, v any) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}
