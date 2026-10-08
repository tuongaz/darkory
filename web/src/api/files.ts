import { useMutation } from "@tanstack/react-query";
import { api, call, fileBody, type FilePurpose, type FileRecord } from "./client";

// Files the Organisation keeps by id (`/v1/files`): an upload is the raw file as the request
// body, as Evidence is. The server reads the type from the bytes; the Content-Type sent is only a
// courtesy. Any feature that keeps a file uses these.

/** The types an Avatar is accepted as; SVG and HTML never, as they can carry script. */
export const avatarTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** The largest image an Avatar is made from. */
export const avatarMaxBytes = 2 << 20;

/** Uploads a file; with purpose `avatar` the server makes it a PNG at most 256 pixels square. */
export function uploadFile(file: File, opts: { purpose?: FilePurpose; name?: string } = {}): Promise<FileRecord> {
  const query = { name: opts.name ?? (file.name || "file"), ...(opts.purpose ? { purpose: opts.purpose } : {}) };
  return call(api.POST("/v1/files", { params: { query }, ...fileBody(file) }));
}

/** Deletes a file: its uploader, or an admin. */
export const deleteFile = (file: string) => call(api.DELETE("/v1/files/{file}", { params: { path: { file } } }));

/**
 * Why a picked file cannot be an Avatar, before anything is sent, or undefined when it can. The
 * server checks again, by the bytes.
 */
export function avatarProblem(file: File): string | undefined {
  if (!avatarTypes.includes(file.type)) return "An Avatar is a PNG, JPEG, WebP or GIF image.";
  if (file.size > avatarMaxBytes) return "An Avatar is at most 2 MB.";
  return undefined;
}

/**
 * Uploading a file as a mutation: `mutate(file)` or `mutateAsync(file)`, with the pending state
 * and the refusal to show. Run its success through whatever names the file (a Member's Avatar).
 */
export function useUploadFile(opts: { purpose?: FilePurpose } = {}) {
  return useMutation({ mutationFn: (file: File) => uploadFile(file, { purpose: opts.purpose }) });
}
