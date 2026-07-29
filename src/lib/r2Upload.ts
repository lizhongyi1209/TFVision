function setHeader(headers: Record<string, string>, name: string, value: string) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
  headers[name] = value;
}

/** Build the exact headers required by a direct Cloudflare R2 presigned PUT. */
export function buildR2UploadHeaders(
  presignedHeaders: Record<string, string>,
  contentType: string,
  contentLength: number,
) {
  const headers = { ...presignedHeaders };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization") delete headers[key];
  }
  setHeader(headers, "Content-Type", contentType);
  setHeader(headers, "Content-Length", String(contentLength));
  return headers;
}
