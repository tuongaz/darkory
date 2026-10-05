// Package dockertest runs a throwaway container for a test that needs a real service, such as
// MinIO for the S3 Evidence store or Mailpit for emailed sign-in.
package dockertest

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Container is a running container.
type Container struct {
	Name string
	// Addr is host:port on the loopback interface for each port asked for, in order.
	Addr []string
}

// Run starts image with env and args, publishing each of ports on a random loopback port. The
// container is removed when the test ends. The test is skipped unless the environment variable
// gate is set and docker answers.
func Run(t testing.TB, gate, image string, ports []int, env map[string]string, args ...string) Container {
	t.Helper()
	if os.Getenv(gate) == "" {
		t.Skipf("%s is not set", gate)
	}
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker is not installed")
	}
	if out, err := exec.Command("docker", "info", "--format", "{{.ServerVersion}}").CombinedOutput(); err != nil {
		t.Skipf("docker is not running: %s", strings.TrimSpace(string(out)))
	}
	var b [6]byte
	_, _ = rand.Read(b[:])
	name := "darkory-test-" + hex.EncodeToString(b[:])
	cmd := []string{"run", "-d", "--rm", "--name", name}
	for _, p := range ports {
		cmd = append(cmd, "-p", fmt.Sprintf("127.0.0.1::%d", p))
	}
	for k, v := range env {
		cmd = append(cmd, "-e", k+"="+v)
	}
	cmd = append(cmd, image)
	cmd = append(cmd, args...)
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	if out, err := exec.Command("docker", cmd...).CombinedOutput(); err != nil {
		t.Fatalf("docker run %s: %v: %s", image, err, out)
	}
	c := Container{Name: name}
	for _, p := range ports {
		out, err := exec.Command("docker", "port", name, fmt.Sprintf("%d/tcp", p)).Output()
		if err != nil {
			t.Fatalf("docker port %s %d: %v", name, p, err)
		}
		c.Addr = append(c.Addr, strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0]))
	}
	return c
}

// WaitHTTP waits until url answers 200, for up to 60 s.
func WaitHTTP(t testing.TB, url string) {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for {
		res, err := http.Get(url)
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s did not answer 200 within 60 s: %v", url, err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}
