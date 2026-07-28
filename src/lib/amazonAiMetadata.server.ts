import { deflateSync, inflateSync } from "node:zlib";

export const AMAZON_SYNTHETIC_PERFORMER_KEYWORD = "contains-synthetic-performer";

const XMP_JPEG_HEADER = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DC_NAMESPACE = "http://purl.org/dc/elements/1.1/";
const RDF_NAMESPACE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

export type AmazonAiMetadataResult = {
  bytes: Buffer;
  format: "jpeg" | "png";
  status: "tagged" | "already-tagged";
};

function createXmpPacket() {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="${RDF_NAMESPACE}">
  <rdf:Description rdf:about="" xmlns:dc="${DC_NAMESPACE}">
   <dc:subject><rdf:Bag><rdf:li>${AMAZON_SYNTHETIC_PERFORMER_KEYWORD}</rdf:li></rdf:Bag></dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function subjectContainsKeyword(xml: string) {
  const subjects = xml.match(/<dc:subject\b[^>]*>[\s\S]*?<\/dc:subject>/gi) ?? [];
  return subjects.some((subject) => {
    const values = subject.match(/<rdf:li\b[^>]*>[\s\S]*?<\/rdf:li>/gi) ?? [];
    return values.some((value) => {
      const text = value.replace(/<[^>]+>/g, "").trim();
      return text === AMAZON_SYNTHETIC_PERFORMER_KEYWORD;
    });
  });
}

function addKeywordToXmp(xml: string) {
  if (subjectContainsKeyword(xml)) return { xml, alreadyTagged: true };

  const listItem = `<rdf:li>${AMAZON_SYNTHETIC_PERFORMER_KEYWORD}</rdf:li>`;
  const subjectPattern = /<dc:subject\b[^>]*>[\s\S]*?<\/dc:subject>/i;
  const subjectMatch = xml.match(subjectPattern);
  if (subjectMatch) {
    const subject = subjectMatch[0];
    const containerClose = subject.match(/<\/(?:rdf:Bag|rdf:Seq|rdf:Alt)\s*>/i);
    const replacement = containerClose
      ? subject.replace(containerClose[0], `${listItem}${containerClose[0]}`)
      : subject.replace(/<\/dc:subject\s*>/i, `<rdf:Bag>${listItem}</rdf:Bag></dc:subject>`);
    return { xml: xml.replace(subjectPattern, replacement), alreadyTagged: false };
  }

  const selfClosingSubject = /<dc:subject\b[^>]*\/\s*>/i;
  if (selfClosingSubject.test(xml)) {
    return {
      xml: xml.replace(selfClosingSubject, `<dc:subject><rdf:Bag>${listItem}</rdf:Bag></dc:subject>`),
      alreadyTagged: false,
    };
  }

  const subject = `<dc:subject xmlns:dc="${DC_NAMESPACE}" xmlns:rdf="${RDF_NAMESPACE}"><rdf:Bag>${listItem}</rdf:Bag></dc:subject>`;
  if (/<\/rdf:Description\s*>/i.test(xml)) {
    return { xml: xml.replace(/<\/rdf:Description\s*>/i, `${subject}</rdf:Description>`), alreadyTagged: false };
  }
  if (/<\/rdf:RDF\s*>/i.test(xml)) {
    const description = `<rdf:Description rdf:about="" xmlns:dc="${DC_NAMESPACE}">${subject}</rdf:Description>`;
    return { xml: xml.replace(/<\/rdf:RDF\s*>/i, `${description}</rdf:RDF>`), alreadyTagged: false };
  }

  throw new Error("图片中的 XMP 数据结构无法安全更新");
}

function jpegSegment(marker: number, payload: Buffer) {
  const length = payload.length + 2;
  if (length > 0xffff) throw new Error("XMP 元数据超过 JPEG 单段容量");
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(length, 2);
  return Buffer.concat([header, payload]);
}

function tagJpeg(bytes: Buffer): AmazonAiMetadataResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("JPEG 文件结构无效");

  let offset = 2;
  let insertionOffset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) throw new Error("JPEG 元数据段长度无效");
    const segmentEnd = offset + 2 + length;
    const payloadStart = offset + 4;
    const payload = bytes.subarray(payloadStart, segmentEnd);
    if (marker === 0xe1 && payload.subarray(0, XMP_JPEG_HEADER.length).equals(XMP_JPEG_HEADER)) {
      const originalXml = payload.subarray(XMP_JPEG_HEADER.length).toString("utf8");
      const updated = addKeywordToXmp(originalXml);
      if (updated.alreadyTagged) return { bytes, format: "jpeg", status: "already-tagged" };
      const nextSegment = jpegSegment(0xe1, Buffer.concat([XMP_JPEG_HEADER, Buffer.from(updated.xml, "utf8")]));
      const nextBytes = Buffer.concat([bytes.subarray(0, offset), nextSegment, bytes.subarray(segmentEnd)]);
      if (!jpegHasAmazonAiKeyword(nextBytes)) throw new Error("JPEG 元数据写入后验证失败");
      return { bytes: nextBytes, format: "jpeg", status: "tagged" };
    }

    if (marker >= 0xe0 && marker <= 0xef) insertionOffset = segmentEnd;
    offset = segmentEnd;
  }

  const packet = jpegSegment(0xe1, Buffer.concat([XMP_JPEG_HEADER, Buffer.from(createXmpPacket(), "utf8")]));
  const nextBytes = Buffer.concat([bytes.subarray(0, insertionOffset), packet, bytes.subarray(insertionOffset)]);
  if (!jpegHasAmazonAiKeyword(nextBytes)) throw new Error("JPEG 元数据写入后验证失败");
  return { bytes: nextBytes, format: "jpeg", status: "tagged" };
}

function readPngChunks(bytes: Buffer) {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("PNG 文件结构无效");
  }
  const chunks: Array<{ offset: number; end: number; type: string; data: Buffer }> = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("PNG 数据块长度无效");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    chunks.push({ offset, end, type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset = end;
    if (type === "IEND") break;
  }
  if (!chunks.some((chunk) => chunk.type === "IEND")) throw new Error("PNG 缺少结束数据块");
  return chunks;
}

function parseInternationalText(data: Buffer) {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd < 0 || keywordEnd + 5 > data.length) return null;
  const keyword = data.subarray(0, keywordEnd).toString("latin1");
  const compressed = data[keywordEnd + 1] === 1;
  const compressionMethod = data[keywordEnd + 2];
  const languageEnd = data.indexOf(0, keywordEnd + 3);
  if (languageEnd < 0) return null;
  const translatedEnd = data.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) return null;
  const textBytes = data.subarray(translatedEnd + 1);
  const text = compressed ? inflateSync(textBytes).toString("utf8") : textBytes.toString("utf8");
  return { keyword, compressed, compressionMethod, prefix: data.subarray(0, translatedEnd + 1), text };
}

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function createPngXmpData(xml: string) {
  return Buffer.concat([
    Buffer.from("XML:com.adobe.xmp\0", "latin1"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from(xml, "utf8"),
  ]);
}

function tagPng(bytes: Buffer): AmazonAiMetadataResult {
  const chunks = readPngChunks(bytes);
  for (const chunk of chunks) {
    if (chunk.type !== "iTXt") continue;
    const parsed = parseInternationalText(chunk.data);
    if (!parsed || parsed.keyword !== "XML:com.adobe.xmp") continue;
    const updated = addKeywordToXmp(parsed.text);
    if (updated.alreadyTagged) return { bytes, format: "png", status: "already-tagged" };
    const textBytes = parsed.compressed ? deflateSync(Buffer.from(updated.xml, "utf8")) : Buffer.from(updated.xml, "utf8");
    const nextData = Buffer.concat([parsed.prefix, textBytes]);
    const nextChunk = pngChunk("iTXt", nextData);
    const nextBytes = Buffer.concat([bytes.subarray(0, chunk.offset), nextChunk, bytes.subarray(chunk.end)]);
    if (!pngHasAmazonAiKeyword(nextBytes)) throw new Error("PNG 元数据写入后验证失败");
    return { bytes: nextBytes, format: "png", status: "tagged" };
  }

  const iend = chunks.find((chunk) => chunk.type === "IEND")!;
  const packet = pngChunk("iTXt", createPngXmpData(createXmpPacket()));
  const nextBytes = Buffer.concat([bytes.subarray(0, iend.offset), packet, bytes.subarray(iend.offset)]);
  if (!pngHasAmazonAiKeyword(nextBytes)) throw new Error("PNG 元数据写入后验证失败");
  return { bytes: nextBytes, format: "png", status: "tagged" };
}

function jpegHasAmazonAiKeyword(bytes: Buffer) {
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return false;
    const end = offset + 2 + length;
    const payload = bytes.subarray(offset + 4, end);
    if (marker === 0xe1 && payload.subarray(0, XMP_JPEG_HEADER.length).equals(XMP_JPEG_HEADER)) {
      if (subjectContainsKeyword(payload.subarray(XMP_JPEG_HEADER.length).toString("utf8"))) return true;
    }
    offset = end;
  }
  return false;
}

function pngHasAmazonAiKeyword(bytes: Buffer) {
  for (const chunk of readPngChunks(bytes)) {
    if (chunk.type !== "iTXt") continue;
    const parsed = parseInternationalText(chunk.data);
    if (parsed?.keyword === "XML:com.adobe.xmp" && subjectContainsKeyword(parsed.text)) return true;
  }
  return false;
}

export function hasAmazonAiMetadata(bytes: Buffer) {
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) return jpegHasAmazonAiKeyword(bytes);
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return pngHasAmazonAiKeyword(bytes);
  return false;
}

export function tagAmazonAiImage(bytes: Buffer): AmazonAiMetadataResult {
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) return tagJpeg(bytes);
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return tagPng(bytes);
  throw new Error("仅支持 JPG、JPEG 和 PNG；WebP 需先导出为亚马逊支持的格式");
}
