/**
 * 相机/解码生命周期闸门（无 DOM 依赖，可单测）。
 *
 * 每次开始扫码获得一个 generation；权限晚返回、异步解码晚完成、页面隐藏
 * 或卸载后的回调都用 generation + decoded 双重校验丢弃。`accept` 同步置
 * latch，确保同一帧/同一码只交给上层一次；`tryBeginDecode` 保证帧循环
 * 串行，不并发解码。
 */
export class ScannerLifecycle {
  private generation = 0;
  private active = false;
  private decoded = false;
  private decoding = false;

  begin(): number {
    this.generation += 1;
    this.active = true;
    this.decoded = false;
    this.decoding = false;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return this.active && !this.decoded && generation === this.generation;
  }

  isActive(): boolean {
    return this.active;
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
    this.decoding = false;
  }

  /** 同步接收识别结果；重复帧或停止后的晚到结果返回 false。 */
  accept(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.decoded = true;
    return true;
  }

  tryBeginDecode(generation: number): boolean {
    if (!this.isCurrent(generation) || this.decoding) return false;
    this.decoding = true;
    return true;
  }

  endDecode(): void {
    this.decoding = false;
  }
}
