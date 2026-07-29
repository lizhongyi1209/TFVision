import assert from "node:assert/strict";
import { test } from "node:test";
import { buildR2UploadHeaders } from "../r2Upload.ts";

test("R2 上传固定内容类型和长度，并移除 O1Key 鉴权头", () => {
  assert.deepEqual(buildR2UploadHeaders({
    authorization: "Bearer must-not-forward",
    "content-type": "application/octet-stream",
    "Content-Length": "1",
    "x-amz-meta-source": "tfvision",
  }, "video/mp4", 1_237_765), {
    "x-amz-meta-source": "tfvision",
    "Content-Type": "video/mp4",
    "Content-Length": "1237765",
  });
});
