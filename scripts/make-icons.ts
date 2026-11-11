import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { root } from "./project";

const out = join(root, "addon", "content", "icons");
mkdirSync(out, { recursive: true });

function crc32(buf: Uint8Array) {
	let c, crc = 0xffffffff;
	for (let n = 0; n < buf.length; n++) {
		c = (crc ^ buf[n]) & 0xff;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crc = (crc >>> 8) ^ c;
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}
function png(size: number, pixel: (x: number, y: number) => number[]) {
	const raw = Buffer.alloc((size * 4 + 1) * size);
	for (let y = 0; y < size; y++) {
		raw[y * (size * 4 + 1)] = 0;
		for (let x = 0; x < size; x++) {
			const [r, g, b, a] = pixel(x, y);
			raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
	]);
}
// Rounded dark square with a white magnifier ring and handle.
function draw(size: number) {
	const s = size;
	return png(s, (x, y) => {
		const r = s * 0.22;
		const cx = Math.min(Math.max(x + 0.5, r), s - r), cy = Math.min(Math.max(y + 0.5, r), s - r);
		const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
		if (!inside) return [0, 0, 0, 0];
		const ringCx = s * 0.44, ringCy = s * 0.44, ringR = s * 0.22, ringW = s * 0.085;
		const d = Math.hypot(x + 0.5 - ringCx, y + 0.5 - ringCy);
		const onRing = Math.abs(d - ringR) <= ringW;
		const hx = x + 0.5 - ringCx, hy = y + 0.5 - ringCy;
		const along = (hx + hy) / Math.SQRT2, across = Math.abs(hx - hy) / Math.SQRT2;
		const onHandle = along > ringR && along < s * 0.42 && across <= ringW;
		if (onRing || onHandle) return [255, 255, 255, 255];
		return [23, 23, 31, 255];
	});
}
for (const size of [48, 96]) writeFileSync(join(out, `topk-${size}.png`), draw(size));
console.log("icons written to", out);
