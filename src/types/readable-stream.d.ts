/**
 * Bun 与 lib.dom 的 ReadableStream 兼容声明。
 *
 * @types/bun 给 `stream/web` 的 ReadableStream 增加了便捷消费方法，
 * 但 lib.dom 的同名接口没有这些方法；同时开启 DOM lib 时，第三方
 * 包在 node/web 与全局流之间转换会报“类型不重叠”。这里只补齐类型，
 * 不改变运行时行为。
 */
interface ReadableStream<R = any> {
  text(): Promise<string>;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  json(): Promise<any>;
  blob(): Promise<Blob>;
}
