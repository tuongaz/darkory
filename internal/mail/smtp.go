package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"net/url"
	"strings"
	"time"
)

// TLS modes of an SMTP URL.
const (
	startTLS = "starttls" // smtp://: upgrade with STARTTLS, and refuse to send when it is not offered
	implicit = "implicit" // smtps://: TLS from the first byte
	noTLS    = "none"     // smtp://…?tls=none: plain text, for a relay on a trusted network
)

// sendTimeout bounds one Send when its context has no deadline.
const sendTimeout = 30 * time.Second

// SMTP sends email through an SMTP server. It authenticates with PLAIN when the URL names a user,
// which net/smtp allows only over TLS or to a server on this machine.
type SMTP struct {
	host, addr string
	mode       string
	user, pass string
	from       *mail.Address
	// tlsConfig verifies the server; nil verifies host against the system's roots.
	tlsConfig *tls.Config
	// redacted is the URL without its password, for errors and logs.
	redacted string
}

var _ Sender = (*SMTP)(nil)

// NewSMTP returns a sender for the server rawURL names, sending from from:
//
//	smtp://user:pass@host:587   STARTTLS, required (the port defaults to 587)
//	smtps://user:pass@host:465  TLS from the start (the port defaults to 465)
//	smtp://host:25?tls=none     no TLS, for a relay on a trusted network
//
// The user and password are percent-encoded in the URL.
func NewSMTP(rawURL, from string) (*SMTP, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, errors.New("mail: DARKORY_SMTP_URL is not a URL")
	}
	s := &SMTP{host: u.Hostname()}
	port := u.Port()
	switch u.Scheme {
	case "smtp":
		s.mode = startTLS
		port = orDefault(port, "587")
	case "smtps":
		s.mode = implicit
		port = orDefault(port, "465")
	default:
		return nil, fmt.Errorf("mail: the SMTP URL's scheme is smtp or smtps, not %q", u.Scheme)
	}
	if s.host == "" {
		return nil, errors.New("mail: the SMTP URL names no host")
	}
	q := u.Query()
	switch q.Get("tls") {
	case "":
	case noTLS:
		if s.mode == implicit {
			return nil, errors.New("mail: smtps:// is TLS from the start; tls=none goes with smtp://")
		}
		s.mode = noTLS
	default:
		return nil, fmt.Errorf("mail: the SMTP URL's tls parameter is none or absent, not %q", q.Get("tls"))
	}
	s.addr = net.JoinHostPort(s.host, port)
	if u.User != nil {
		s.user = u.User.Username()
		s.pass, _ = u.User.Password()
	}
	s.redacted = u.Redacted()
	if s.from, err = mail.ParseAddress(from); err != nil {
		return nil, fmt.Errorf("mail: DARKORY_SMTP_FROM %q is not an email address", from)
	}
	return s, nil
}

// String is the server's URL without its password.
func (s *SMTP) String() string { return s.redacted }

// Send delivers m, giving up when ctx ends or after 30 s.
func (s *SMTP) Send(ctx context.Context, m Message) error {
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return fmt.Errorf("mail: %q is not an email address", m.To)
	}
	msg, err := s.compose(to, m)
	if err != nil {
		return err
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, sendTimeout)
		defer cancel()
	}
	if err := s.send(ctx, to.Address, msg); err != nil {
		return fmt.Errorf("mail: send through %s: %w", s.redacted, err)
	}
	return nil
}

func (s *SMTP) tls() *tls.Config {
	if s.tlsConfig != nil {
		return s.tlsConfig.Clone()
	}
	return &tls.Config{ServerName: s.host}
}

func (s *SMTP) send(ctx context.Context, to string, msg []byte) error {
	var conn net.Conn
	var err error
	d := &net.Dialer{}
	if s.mode == implicit {
		conn, err = (&tls.Dialer{NetDialer: d, Config: s.tls()}).DialContext(ctx, "tcp", s.addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", s.addr)
	}
	if err != nil {
		return err
	}
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	// A cancelled ctx stops a conversation already under way.
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stop()

	c, err := smtp.NewClient(conn, s.host)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	if err := c.Hello("localhost"); err != nil {
		return err
	}
	if s.mode == startTLS {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("the server does not offer STARTTLS; use smtps://, or smtp://…?tls=none for a relay on a trusted network")
		}
		if err := c.StartTLS(s.tls()); err != nil {
			return err
		}
	}
	if s.user != "" {
		if ok, _ := c.Extension("AUTH"); !ok {
			return errors.New("the server does not offer AUTH, and the URL names a user")
		}
		if err := c.Auth(smtp.PlainAuth("", s.user, s.pass, s.host)); err != nil {
			return err
		}
	}
	if err := c.Mail(s.from.Address); err != nil {
		return err
	}
	if err := c.Rcpt(to); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// compose writes m as an RFC 5322 message: UTF-8 text, quoted-printable, every header encoded so
// no value can break a line.
func (s *SMTP) compose(to *mail.Address, m Message) ([]byte, error) {
	if strings.ContainsAny(m.Subject, "\r\n") {
		return nil, errors.New("mail: a subject is one line")
	}
	var id [12]byte
	_, _ = rand.Read(id[:])
	domain := s.from.Address[strings.LastIndex(s.from.Address, "@")+1:]
	var b bytes.Buffer
	for _, h := range [][2]string{
		{"From", s.from.String()},
		{"To", (&mail.Address{Address: to.Address}).String()},
		{"Subject", mime.QEncoding.Encode("utf-8", m.Subject)},
		{"Date", time.Now().Format(time.RFC1123Z)},
		{"Message-ID", "<" + hex.EncodeToString(id[:]) + "@" + domain + ">"},
		{"MIME-Version", "1.0"},
		{"Content-Type", "text/plain; charset=utf-8"},
		{"Content-Transfer-Encoding", "quoted-printable"},
	} {
		b.WriteString(h[0] + ": " + h[1] + "\r\n")
	}
	b.WriteString("\r\n")
	qp := quotedprintable.NewWriter(&b)
	// In text mode the writer ends every line, \n or \r\n, with \r\n.
	if _, err := qp.Write([]byte(m.Text)); err != nil {
		return nil, err
	}
	if err := qp.Close(); err != nil {
		return nil, err
	}
	b.WriteString("\r\n")
	return b.Bytes(), nil
}

func orDefault(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}
