package server

import (
	"crypto/sha256"
	"encoding/base64"
	"html/template"
	"net/http"
)

// loginStyle is the sign-in page's only style: the web app's sign-in card (mock F-D8b) on the
// muted ground, light only, as the app is. The page's Content-Security-Policy allows it by its
// hash, and nothing else: no script, no other style, no font, no frame, and forms only to this
// Install. So the type is Inter where the system has it, else the system's own sans.
const loginStyle = `:root{color-scheme:light}*{box-sizing:border-box}` +
	`body{margin:0;min-height:100vh;background:oklch(.985 0 0);color:oklch(.145 0 0);` +
	`font:13px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}` +
	`main{max-width:552px;margin:0 auto;padding:72px 16px 32px;display:flex;flex-direction:column;gap:16px}` +
	`.brand{font-weight:600;font-size:15px;letter-spacing:-.01em;text-align:center}` +
	`.card{background:oklch(1 0 0);border:1px solid oklch(.922 0 0);border-radius:10px;padding:28px;` +
	`display:flex;flex-direction:column;align-items:flex-start;gap:14px;box-shadow:0 1px 2px oklch(0 0 0/.04)}` +
	`h1{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em;line-height:1.25}` +
	`p{margin:0;line-height:1.55}form{margin:0}` +
	`button{font:inherit;font-weight:500;height:32px;padding:0 10px;border:1px solid transparent;border-radius:8px;` +
	`background:oklch(.205 0 0);color:oklch(.985 0 0);cursor:pointer;white-space:nowrap}` +
	`button:hover{background:oklch(.205 0 0/.9)}button:focus-visible{outline:none;box-shadow:0 0 0 3px oklch(.708 0 0/.5)}` +
	`.note{font-size:12px;color:oklch(.556 0 0)}`

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
<meta name="color-scheme" content="light">
<title>Sign in to Darkory</title>
<style>` + loginStyle + `</style>
</head>
<body>
<main>
<div class="brand">Darkory</div>
<div class="card">
{{if .Member -}}
<h1>Sign in to Darkory</h1>
<p>This link signs this browser in as <strong>{{.Member}}</strong>, in {{.Organisation}}.</p>
<form method="post"><button type="submit">Sign in as {{.Member}}</button></form>
<p class="note">The link works once, for {{.Minutes}} minutes from when it was made. If you did not ask for it, close this page.</p>
{{- else -}}
<h1>This login link does not work</h1>
<p>It is unknown, used or expired. Ask an admin for a new one.</p>
{{- end}}
</div>
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
