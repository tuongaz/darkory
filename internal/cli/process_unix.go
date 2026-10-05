//go:build !windows

package cli

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// detach starts cmd in a session of its own, so it outlives the terminal that started it.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func processAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}

func terminate(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Signal(syscall.SIGTERM)
}

// watchProcess returns a context that ends when process pid exits.
func watchProcess(ctx context.Context, pid int) (context.Context, func()) {
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if !processAlive(pid) {
					cancel()
					return
				}
			}
		}
	}()
	return ctx, cancel
}
