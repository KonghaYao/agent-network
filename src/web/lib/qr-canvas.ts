import { encode } from 'uqr';

/** 把文本编码成二维码并画到 canvas；白底黑块，四周留 2 模块静区。 */
export function drawQrCanvas(canvas: HTMLCanvasElement, text: string): void {
  if (!text) throw new Error('二维码内容为空');
  const result = encode(text, { ecc: 'M', border: 2 });
  const scale = Math.max(2, Math.ceil(280 / result.size));
  canvas.width = result.size * scale;
  canvas.height = result.size * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持 canvas');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111111';
  for (let row = 0; row < result.size; row += 1) {
    for (let column = 0; column < result.size; column += 1) {
      if (!result.data[row]?.[column]) continue;
      context.fillRect(column * scale, row * scale, scale, scale);
    }
  }
}
