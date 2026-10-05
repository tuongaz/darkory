package server

import (
	"crypto/sha256"
	"encoding/base64"
	"html/template"
	"net/http"
)

// loginStyle is the sign-in page's only style. The page's Content-Security-Policy allows it by its
// hash, and nothing else: no script, no other style, no frame, and forms only to this Install.
const loginStyle = `body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}` +
	`main{max-width:28rem;padding:2rem}h1{font-size:1.4rem}` +
	`button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid;cursor:pointer}` +
	`.note{opacity:.7;font-size:.9rem}`

var (
	loginCSP = func() string {
		sum := sha256.Sum256([]byte(loginStyle))
		return "default-src 'none'; style-src 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'; " +
			"form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
	}()
	// The form has no action, so it posts to the page's own address: the link.
	loginTemplate = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Sign in to Darkory</title>
<style>` + loginStyle + `</style>
</head>
<body>
<main>
{{if .Member -}}
<h1>Sign in to Darkory</h1>
<p>This link signs this browser in as <strong>{{.Member}}</strong>, in {{.Organisation}}.</p>
<form method="post"><button type="submit">Sign in as {{.Member}}</button></form>
<p class="note">The link works once, for {{.Minutes}} minutes from when it was made. If you did not ask for it, close this page.</p>
{{- else -}}
<h1>This login link does not work</h1>
<p>It is unknown, used or expired. Ask an admin for a new one.</p>
{{- end}}
</main>
</body>
</html>
`))
)

type loginPageData struct {
	Member, Organisation string
	Minutes              int
}

// loginPage writes the sign-in page, kept out of caches.
func loginPage(w http.ResponseWriter, status int, d loginPageData) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", loginCSP)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = loginTemplate.Execute(w, d)
}
