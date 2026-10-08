package cli

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

// Files: bytes the Organisation keeps by id, such as avatars, through /v1/files.
var fileCommands = []command{
	{path: "files upload", args: "<path> [--name n] [--avatar]", short: "upload a file the Organisation keeps; with --avatar, an image made a 256-pixel square for member update --avatar", run: cmdFilesUpload},
	{path: "files get", args: "<id> [-o file|-]", short: "show a file's record, or download its bytes", run: cmdFilesGet},
	{path: "files delete", args: "<id>", short: "delete a file you uploaded (an admin: any)", run: cmdFilesDelete},
}

func cmdFilesUpload(c *call) error {
	name := c.fs.String("name", "", "the name to show and download it as (default: the file's own)")
	asAvatar := c.fs.Bool("avatar", false, "upload an image as an avatar: a PNG, JPEG, WebP or GIF of at most 2 MiB")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	content, err := os.ReadFile(args[0])
	if err != nil {
		return err
	}
	filename := *name
	if filename == "" {
		filename = filepath.Base(args[0])
	}
	params := &client.UploadFileParams{Name: filename}
	if *asAvatar {
		p := client.FilePurposeAvatar
		params.Purpose = &p
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	// Show what is about to be sent, so a person sees which file leaves the machine.
	shown, err := filepath.Abs(args[0])
	if err != nil {
		return err
	}
	if real, err := filepath.EvalSymlinks(shown); err == nil && real != shown {
		shown += " -> " + real
	}
	fmt.Fprintf(c.errOut(), "Uploading %s (%d bytes) as %s.\n", shown, len(content), filename)
	// The server reads the type from the bytes; the one sent is only a courtesy.
	res, err := conn.UploadFileWithBodyWithResponse(c.ctx, params, remote.ContentType(filename, content), bytes.NewReader(content))
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		fmt.Fprintf(w, "Uploaded %s.\n", filename)
		c.printFile(w, *res.JSON201)
	})
}

func cmdFilesGet(c *call) error {
	out := c.fs.String("o", "", "download the bytes here; - for standard output")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	if *out == "" {
		res, err := conn.GetFileWithResponse(c.ctx, args[0])
		if err := check(res, err, http.StatusOK); err != nil {
			return err
		}
		return c.show(res.Body, func(w io.Writer) { c.printFile(w, *res.JSON200) })
	}
	res, err := conn.ClientInterface.DownloadFile(c.ctx, args[0], &client.DownloadFileParams{})
	return c.save(res, err, *out)
}

func cmdFilesDelete(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.DeleteFileWithResponse(c.ctx, args[0], &client.DeleteFileParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { fmt.Fprintf(w, "Deleted file %s.\n", args[0]) })
}

func (c *call) printFile(w io.Writer, f client.File) {
	fmt.Fprintf(w, "  %s  %s  %s  %d bytes  %s  by %s at %s\n", one(f.ID), one(f.Name), one(f.ContentType), f.Size, f.Purpose,
		c.member(f.CreatedBy), stamp(f.CreatedAt))
}
