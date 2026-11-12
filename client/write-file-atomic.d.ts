declare module 'write-file-atomic' {
  interface WriteFileAtomicOptions {
    mode?: number;
    fsync?: boolean;
    encoding?: BufferEncoding;
  }

  interface WriteFileAtomic {
    (path: string, data: string | Uint8Array, options?: WriteFileAtomicOptions): Promise<void>;
    sync(path: string, data: string | Uint8Array, options?: WriteFileAtomicOptions): void;
  }

  const writeFileAtomic: WriteFileAtomic;
  export = writeFileAtomic;
}
