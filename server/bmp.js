'use strict';

/**
 * 极简 BMP 解码器。
 *
 * 为什么需要它：sharp / libvips 不支持读 BMP，但很多扫描仪导出的就是 BMP。
 * 这里只处理**未压缩**的常见情况（BI_RGB，8/24/32 位），覆盖扫描仪实际会给出的格式；
 * 遇到 RLE 压缩或非常规位深时明确报错，让用户另存为 TIFF/PNG，而不是悄悄出错。
 *
 * 解出来是 RGBA，直接喂给 sharp({ raw: {...} })。
 */

function decodeBMP(buf) {
  if (buf.length < 54) throw new Error('BMP 文件太小，可能已损坏');
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error('不是 BMP 文件（缺少 BM 标识）');

  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);

  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);

  if (width <= 0 || height <= 0) throw new Error('BMP 尺寸异常：' + width + 'x' + height);
  if (width * height > 400 * 1000 * 1000) throw new Error('BMP 尺寸过大，拒绝处理');
  if (compression !== 0) {
    throw new Error(
      '这个 BMP 使用了压缩编码（compression=' + compression + '），暂不支持。' +
      '请在扫描/看图软件里另存为 TIFF 或 PNG 再上传。'
    );
  }
  if ([8, 24, 32].indexOf(bpp) === -1) {
    throw new Error(
      '这个 BMP 是 ' + bpp + ' 位色深，暂不支持（支持 8/24/32 位）。' +
      '请另存为 TIFF 或 PNG 再上传。'
    );
  }

  // 调色板（仅 8 位）
  let palette = null;
  if (bpp === 8) {
    const count = buf.readUInt32LE(46) || 256;
    const start = 14 + headerSize;
    if (start + count * 4 > buf.length) throw new Error('BMP 调色板数据不完整');
    palette = new Uint8Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const o = start + i * 4;
      palette[i * 3] = buf[o + 2]; // R
      palette[i * 3 + 1] = buf[o + 1]; // G
      palette[i * 3 + 2] = buf[o]; // B
    }
  }

  const bytesPerPixel = bpp / 8;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const needed = dataOffset + rowSize * height;
  if (needed > buf.length) throw new Error('BMP 像素数据不完整（可能被截断）');

  const out = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const srcRow = dataOffset + (topDown ? y : height - 1 - y) * rowSize;
    const dstRow = y * width * 4;

    for (let x = 0; x < width; x += 1) {
      const d = dstRow + x * 4;
      if (bpp === 8) {
        const idx = buf[srcRow + x];
        out[d] = palette[idx * 3];
        out[d + 1] = palette[idx * 3 + 1];
        out[d + 2] = palette[idx * 3 + 2];
        out[d + 3] = 255;
      } else if (bpp === 24) {
        const s = srcRow + x * 3;
        out[d] = buf[s + 2];
        out[d + 1] = buf[s + 1];
        out[d + 2] = buf[s];
        out[d + 3] = 255;
      } else {
        // 32 位：BMP 里是 BGRA，A 常常恒为 0，当作不透明处理
        const s = srcRow + x * 4;
        out[d] = buf[s + 2];
        out[d + 1] = buf[s + 1];
        out[d + 2] = buf[s];
        const a = buf[s + 3];
        out[d + 3] = a === 0 ? 255 : a;
      }
    }
  }

  return { width, height, data: out };
}

module.exports = { decodeBMP };
