import assert from "node:assert/strict";
import test from "node:test";
import {
  AMAZON_SYNTHETIC_PERFORMER_KEYWORD,
  crc32,
  hasAmazonAiMetadata,
  tagAmazonAiImage,
} from "../amazonAiMetadata.server.ts";

function pngChunk(type: string, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

test("JPEG 写入准确的 XMP dc:subject，且二次处理保持幂等", () => {
  const scanData = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9]);
  const source = Buffer.concat([Buffer.from([0xff, 0xd8]), scanData]);

  const first = tagAmazonAiImage(source);
  assert.equal(first.format, "jpeg");
  assert.equal(first.status, "tagged");
  assert.equal(hasAmazonAiMetadata(first.bytes), true);
  assert.ok(first.bytes.includes(Buffer.from(`<rdf:li>${AMAZON_SYNTHETIC_PERFORMER_KEYWORD}</rdf:li>`)));
  assert.deepEqual(first.bytes.subarray(first.bytes.length - scanData.length), scanData);

  const second = tagAmazonAiImage(first.bytes);
  assert.equal(second.status, "already-tagged");
  assert.deepEqual(second.bytes, first.bytes);
});

test("PNG 新增标准 iTXt XMP 块，不改变已有图片数据块", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const ihdr = pngChunk("IHDR", ihdrData);
  const imageData = pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01]));
  const source = Buffer.concat([signature, ihdr, imageData, pngChunk("IEND")]);

  const first = tagAmazonAiImage(source);
  assert.equal(first.format, "png");
  assert.equal(first.status, "tagged");
  assert.equal(hasAmazonAiMetadata(first.bytes), true);
  assert.ok(first.bytes.includes(Buffer.from("XML:com.adobe.xmp\0", "latin1")));
  assert.ok(first.bytes.includes(imageData));

  const second = tagAmazonAiImage(first.bytes);
  assert.equal(second.status, "already-tagged");
  assert.deepEqual(second.bytes, first.bytes);
});
