package mail

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"io"
	"math/big"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/textproto"
	"strings"
	"sync"
	"testing"
	"time"
)

// server is a small SMTP server for tests: it offers STARTTLS, or speaks TLS from the start, and
// takes AUTH PLAIN once the connection is encrypted.
type server struct {
	ln       net.Listener
	tls      *tls.Config
	starttls bool // offer STARTTLS
	implicit bool // TLS from the first byte
	silent   bool // accept and never answer

	mu       sync.Mutex
	received []delivery
}

type delivery struct {
	encrypted  bool
	user, pass string
	from, to   string
	data       string
}

// newServer starts a server; mode is "starttls", "implicit", "plain" or "silent".
func newServer(t *testing.T, cert tls.Certificate, mode string) *server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &server{ln: ln, tls: &tls.Config{Certificates: []tls.Certificate{cert}},
		starttls: mode == "starttls" || mode == "silent", implicit: mode == "implicit", silent: mode == "silent"}
	implicit := s.implicit
	if implicit {
		s.ln = tls.NewListener(ln, s.tls)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := s.ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c)
		}
	}()
	return s
}

func (s *server) port() string { _, p, _ := net.SplitHostPort(s.ln.Addr().String()); return p }

func (s *server) deliveries() []delivery {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]delivery(nil), s.received...)
}

func (s *server) serve(c net.Conn) {
	defer c.Close()
	if s.silent {
		_, _ = io.Copy(io.Discard, c)
		return
	}
	d := delivery{encrypted: s.implicit}
	tp := textproto.NewConn(c)
	reply := func(line string) { _ = tp.PrintfLine("%s", line) }
	reply("220 test ESMTP")
	for {
		line, err := tp.ReadLine()
		if err != nil {
			return
		}
		verb, arg, _ := strings.Cut(line, " ")
		switch strings.ToUpper(verb) {
		case "EHLO":
			lines := []string{"250-test"}
			if s.starttls && !d.encrypted {
				lines = append(lines, "250-STARTTLS")
			}
			if d.encrypted {
				lines = append(lines, "250-AUTH PLAIN")
			}
			lines = append(lines, "250 8BITMIME")
			for _, l := range lines {
				reply(l)
			}
		case "STARTTLS":
			reply("220 go ahead")
			tc := tls.Server(c, s.tls)
			if err := tc.Handshake(); err != nil {
				return
			}
			c, d.encrypted = tc, true
			tp = textproto.NewConn(tc)
		case "AUTH":
			mech, b64, _ := strings.Cut(arg, " ")
			raw, err := base64.StdEncoding.DecodeString(b64)
			parts := strings.Split(string(raw), "\x00")
			if mech != "PLAIN" || err != nil || len(parts) != 3 || !d.encrypted {
				reply("535 no")
				continue
			}
			d.user, d.pass = parts[1], parts[2]
			reply("235 ok")
		case "MAIL":
			d.from, _, _ = strings.Cut(strings.TrimPrefix(strings.TrimPrefix(arg, "FROM:"), "<"), ">")
			reply("250 ok")
		case "RCPT":
			d.to, _, _ = strings.Cut(strings.TrimPrefix(strings.TrimPrefix(arg, "TO:"), "<"), ">")
			reply("250 ok")
		case "DATA":
			reply("354 go on")
			b, err := tp.ReadDotBytes()
			if err != nil {
				return
			}
			d.data = string(b)
			s.mu.Lock()
			s.received = append(s.received, d)
			s.mu.Unlock()
			reply("250 queued")
		case "QUIT":
			reply("221 bye")
			return
		default:
			reply("502 what")
		}
	}
}

// selfSigned makes a certificate for 127.0.0.1 and a pool that trusts it.
func selfSigned(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test smtp"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)}, DNSNames: []string{"localhost"},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, pool
}

func sender(t *testing.T, rawURL string, roots *x509.CertPool) *SMTP {
	t.Helper()
	s, err := NewSMTP(rawURL, "Darkory <darkory@example.com>")
	if err != nil {
		t.Fatal(err)
	}
	s.tlsConfig = &tls.Config{ServerName: "127.0.0.1", RootCAs: roots}
	return s
}

var link = Message{
	To:      "ada@example.com",
	Subject: "Sign in to Darkory — Acme",
	Text:    "Open this link within 15 minutes:\n\nhttps://darkory.example.com/v1/login-links/" + strings.Repeat("a", 60) + "\n",
}

// read parses a delivered message and returns its headers and decoded text.
func read(t *testing.T, data string) (mail.Header, string) {
	t.Helper()
	msg, err := mail.ReadMessage(strings.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(quotedprintable.NewReader(msg.Body))
	if err != nil {
		t.Fatal(err)
	}
	return msg.Header, string(body)
}

func TestSendWithSTARTTLSAndAuth(t *testing.T) {
	cert, roots := selfSigned(t)
	srv := newServer(t, cert, "starttls")
	s := sender(t, "smtp://ada%40example.com:p%40ss%20word@127.0.0.1:"+srv.port(), roots)
	if err := s.Send(t.Context(), link); err != nil {
		t.Fatal(err)
	}
	got := srv.deliveries()
	if len(got) != 1 {
		t.Fatalf("%d deliveries", len(got))
	}
	d := got[0]
	if !d.encrypted || d.user != "ada@example.com" || d.pass != "p@ss word" || d.from != "darkory@example.com" || d.to != "ada@example.com" {
		t.Fatalf("delivered %+v", d)
	}
	h, text := read(t, d.data)
	subject, _ := new(mime.WordDecoder).DecodeHeader(h.Get("Subject"))
	if h.Get("From") != `"Darkory" <darkory@example.com>` || h.Get("To") != "<ada@example.com>" || subject != link.Subject {
		t.Fatalf("headers %v (subject %q)", h, subject)
	}
	// The server hands over lines ending \n, as textproto reads them.
	if strings.TrimRight(text, "\n") != strings.TrimRight(link.Text, "\n") {
		t.Fatalf("text %q, want %q", text, link.Text)
	}
	if strings.Contains(s.String(), "p@ss") || strings.Contains(s.String(), "p%40ss") {
		t.Fatalf("String shows the password: %s", s)
	}
}

func TestSendWithImplicitTLS(t *testing.T) {
	cert, roots := selfSigned(t)
	srv := newServer(t, cert, "implicit")
	if err := sender(t, "smtps://u:p@127.0.0.1:"+srv.port(), roots).Send(t.Context(), link); err != nil {
		t.Fatal(err)
	}
	if got := srv.deliveries(); len(got) != 1 || !got[0].encrypted || got[0].user != "u" {
		t.Fatalf("delivered %+v", got)
	}
}

// smtp:// insists on STARTTLS, even to this machine, unless the URL says tls=none.
func TestSendRefusesPlainTextUnlessAskedFor(t *testing.T) {
	cert, roots := selfSigned(t)
	srv := newServer(t, cert, "plain")
	err := sender(t, "smtp://127.0.0.1:"+srv.port(), roots).Send(t.Context(), link)
	if err == nil || !strings.Contains(err.Error(), "STARTTLS") {
		t.Fatalf("sent without STARTTLS: %v", err)
	}
	if got := srv.deliveries(); len(got) != 0 {
		t.Fatalf("delivered %d in plain text", len(got))
	}
	if err := sender(t, "smtp://127.0.0.1:"+srv.port()+"?tls=none", roots).Send(t.Context(), link); err != nil {
		t.Fatal(err)
	}
	if got := srv.deliveries(); len(got) != 1 || got[0].encrypted {
		t.Fatalf("delivered %+v", got)
	}
}

// A certificate the sender does not trust stops the send before the password goes out.
func TestSendChecksTheCertificate(t *testing.T) {
	cert, _ := selfSigned(t)
	srv := newServer(t, cert, "starttls")
	_, otherRoots := selfSigned(t)
	if err := sender(t, "smtp://u:p@127.0.0.1:"+srv.port(), otherRoots).Send(t.Context(), link); err == nil {
		t.Fatal("sent to a server with an untrusted certificate")
	}
	if got := srv.deliveries(); len(got) != 0 {
		t.Fatalf("delivered %+v", got)
	}
}

func TestSendGivesUpWhenTheContextEnds(t *testing.T) {
	cert, roots := selfSigned(t)
	srv := newServer(t, cert, "silent")
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := sender(t, "smtp://127.0.0.1:"+srv.port(), roots).Send(ctx, link); err == nil {
		t.Fatal("sent to a silent server")
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("gave up after %s", took)
	}
}

func TestSendRefusesHeaderInjection(t *testing.T) {
	cert, roots := selfSigned(t)
	srv := newServer(t, cert, "starttls")
	s := sender(t, "smtp://127.0.0.1:"+srv.port(), roots)
	for _, m := range []Message{
		{To: "ada@example.com\r\nBcc: eve@example.com", Subject: "x", Text: "x"},
		{To: "ada@example.com", Subject: "x\r\nBcc: eve@example.com", Text: "x"},
	} {
		if err := s.Send(t.Context(), m); err == nil {
			t.Fatalf("sent %+v", m)
		}
	}
	if got := srv.deliveries(); len(got) != 0 {
		t.Fatalf("delivered %+v", got)
	}
}

func TestNewSMTP(t *testing.T) {
	for _, c := range []struct{ url, from, addr, mode string }{
		{"smtp://mail.example.com", "dk@example.com", "mail.example.com:587", startTLS},
		{"smtps://mail.example.com", "dk@example.com", "mail.example.com:465", implicit},
		{"smtp://mail.example.com:25?tls=none", "Darkory <dk@example.com>", "mail.example.com:25", noTLS},
	} {
		s, err := NewSMTP(c.url, c.from)
		if err != nil {
			t.Fatalf("%s: %v", c.url, err)
		}
		if s.addr != c.addr || s.mode != c.mode {
			t.Fatalf("%s: %s %s", c.url, s.addr, s.mode)
		}
	}
	for _, c := range []struct{ url, from string }{
		{"http://mail.example.com", "dk@example.com"},
		{"smtp://", "dk@example.com"},
		{"smtp://mail.example.com?tls=maybe", "dk@example.com"},
		{"smtps://mail.example.com?tls=none", "dk@example.com"},
		{"smtp://mail.example.com", "not an address"},
	} {
		if _, err := NewSMTP(c.url, c.from); err == nil {
			t.Fatalf("accepted %s from %s", c.url, c.from)
		}
	}
	if _, err := NewSMTP("smtp://u:secret@mail.example.com:bad port", "dk@example.com"); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("a bad URL: %v", err)
	}
}

// The fake keeps messages in order and can hold sends.
func TestFake(t *testing.T) {
	f := NewFake()
	f.Block = make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- f.Send(context.Background(), link) }()
	if _, ok := f.Next(50 * time.Millisecond); ok {
		t.Fatal("a held send went out")
	}
	close(f.Block)
	if m, ok := f.Next(time.Second); !ok || m.To != link.To {
		t.Fatalf("got %+v, %v", m, ok)
	}
	if err := <-done; err != nil || len(f.Sent()) != 1 {
		t.Fatalf("%v, sent %d", err, len(f.Sent()))
	}
}
