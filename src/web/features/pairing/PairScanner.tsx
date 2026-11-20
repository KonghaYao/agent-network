import { useCallback, useEffect, useRef, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import { ScannerLifecycle } from './scanner-lifecycle';

/**
 * 手机端配对二维码扫描。
 *
 * 摄像头只在用户打开扫描后请求；优先原生 BarcodeDetector，确认不支持
 * `qr_code` 时才动态加载 `jsqr`（不进入口 chunk）。帧循环串行，识别成功、
 * 取消、页面隐藏或卸载都会停止所有视频轨道并清空 srcObject。权限晚返回
 * 时按 generation 丢弃并停轨，避免离页后相机仍开。
 */

interface PairScannerProps {
  onDecoded: (rawValue: string) => void;
  onCancel: () => void;
}

type ScannerState = 'starting' | 'scanning' | 'stopped' | 'error';

interface DetectedBarcodeLike {
  rawValue?: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcodeLike[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

interface FrameDecoder {
  kind: 'native' | 'jsqr';
  decode(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<string>;
}

function cameraErrorText(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '相机权限被拒绝。你仍可以在下方输入 12 位配对码。';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '没有找到可用相机。请在下方输入 12 位配对码。';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return '相机暂时不可用，可能被其他应用占用。可重试或在下方输入配对码。';
  }
  return '无法打开相机。请在下方输入 12 位配对码。';
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // 轨道已结束时忽略。
    }
  }
}

async function createFrameDecoder(): Promise<FrameDecoder | null> {
  const detectorConstructor = (
    window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }
  ).BarcodeDetector;
  if (detectorConstructor) {
    try {
      const formats =
        typeof detectorConstructor.getSupportedFormats === 'function'
          ? await detectorConstructor.getSupportedFormats()
          : [];
      if (formats.includes('qr_code')) {
        const detector = new detectorConstructor({ formats: ['qr_code'] });
        return {
          kind: 'native',
          async decode(video) {
            const codes = await detector.detect(video);
            return codes.find((code) => typeof code.rawValue === 'string')?.rawValue ?? '';
          },
        };
      }
    } catch {
      // 原生检测器初始化失败时退回本地软件解码。
    }
  }

  try {
    const { default: decodeQr } = await import('jsqr');
    return {
      kind: 'jsqr',
      async decode(video, canvas) {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) return '';
        const scale = Math.min(
          1,
          LIMITS.webPairingScanMaxDimension / Math.max(width, height),
        );
        const targetWidth = Math.max(1, Math.round(width * scale));
        const targetHeight = Math.max(1, Math.round(height * scale));
        if (canvas.width !== targetWidth) canvas.width = targetWidth;
        if (canvas.height !== targetHeight) canvas.height = targetHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return '';
        context.drawImage(video, 0, 0, targetWidth, targetHeight);
        const image = context.getImageData(0, 0, targetWidth, targetHeight);
        const result = decodeQr(image.data, targetWidth, targetHeight);
        return result?.data ?? '';
      },
    };
  } catch {
    return null;
  }
}

export function PairScanner({ onDecoded, onCancel }: PairScannerProps) {
  const lifecycle = useRef(new ScannerLifecycle()).current;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const onDecodedRef = useRef(onDecoded);
  onDecodedRef.current = onDecoded;

  const [state, setState] = useState<ScannerState>('starting');
  const [message, setMessage] = useState('正在请求相机权限…');
  const [decoderKind, setDecoderKind] = useState<'native' | 'jsqr' | ''>('');
  const [retryVisible, setRetryVisible] = useState(false);

  const stopCamera = useCallback(
    (nextMessage?: string) => {
      lifecycle.stop();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const stream = streamRef.current;
      streamRef.current = null;
      if (stream) stopTracks(stream);
      const video = videoRef.current;
      if (video) {
        try {
          video.pause();
        } catch {
          // 未开始播放时忽略。
        }
        video.srcObject = null;
      }
      if (nextMessage && mounted.current) {
        setState('stopped');
        setMessage(nextMessage);
        setRetryVisible(true);
      }
    },
    [lifecycle],
  );

  const fail = useCallback(
    (text: string) => {
      stopCamera();
      if (!mounted.current) return;
      setState('error');
      setMessage(text);
      setRetryVisible(true);
    },
    [stopCamera],
  );

  const schedule = useCallback(
    (generation: number, decoder: FrameDecoder) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void (async () => {
          if (!lifecycle.isCurrent(generation)) return;
          if (!lifecycle.tryBeginDecode(generation)) {
            schedule(generation, decoder);
            return;
          }
          let raw = '';
          try {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (video && canvas && video.readyState >= 2) {
              raw = await decoder.decode(video, canvas);
            }
          } catch {
            // 单帧失败继续扫描，不弹高频错误。
          } finally {
            lifecycle.endDecode();
          }
          if (raw && lifecycle.accept(generation)) {
            stopCamera();
            onDecodedRef.current(raw);
            return;
          }
          if (lifecycle.isCurrent(generation)) schedule(generation, decoder);
        })();
      }, LIMITS.webPairingScanIntervalMs);
    },
    [lifecycle, stopCamera],
  );

  const start = useCallback(async () => {
    stopCamera();
    if (!mounted.current) return;
    setState('starting');
    setMessage('正在请求相机权限…');
    setRetryVisible(false);
    setDecoderKind('');

    if (!window.isSecureContext) {
      fail('当前页面不是安全连接（HTTPS），无法使用相机。请输入 12 位配对码。');
      return;
    }
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      fail('当前浏览器不支持相机扫码。请输入 12 位配对码。');
      return;
    }

    const generation = lifecycle.begin();
    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (error) {
      if (!mounted.current || !lifecycle.isCurrent(generation)) return;
      fail(cameraErrorText(error));
      return;
    }
    if (!mounted.current || !lifecycle.isCurrent(generation)) {
      stopTracks(stream);
      return;
    }

    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      fail('相机画面初始化失败。请输入 12 位配对码。');
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // 静音内联视频通常可自动播放；即使 play 被拒绝，检测仍可尝试。
    }
    if (!mounted.current || !lifecycle.isCurrent(generation)) {
      stopTracks(stream);
      streamRef.current = null;
      return;
    }

    const decoder = await createFrameDecoder();
    if (!mounted.current || !lifecycle.isCurrent(generation)) {
      stopTracks(stream);
      streamRef.current = null;
      return;
    }
    if (!decoder) {
      fail('无法加载二维码解码器。请输入 12 位配对码。');
      return;
    }
    setDecoderKind(decoder.kind);
    setState('scanning');
    setMessage('将电脑上的配对二维码放入框内，识别后会自动停止相机。');
    schedule(generation, decoder);
  }, [fail, lifecycle, schedule, stopCamera]);

  useEffect(() => {
    mounted.current = true;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stopCamera('相机已停止。返回后请点击“重新打开相机”。');
      }
    };
    const onPageHide = () => stopCamera();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    void start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      mounted.current = false;
      stopCamera();
    };
  }, [start, stopCamera]);

  return (
    <section
      className="pair-scanner"
      id="pair-scanner"
      aria-label="扫描配对二维码"
      data-state={state}
      data-decoder={decoderKind || undefined}
    >
      <div className="pair-scanner-frame">
        <video
          id="pair-scanner-video"
          ref={videoRef}
          className="pair-scanner-video"
          playsInline
          muted
          autoPlay
          aria-label="相机画面"
        />
        <canvas ref={canvasRef} hidden />
      </div>
      <p id="pair-scanner-status" role="status">
        {message}
      </p>
      <div className="row pair-scanner-actions">
        {retryVisible ? (
          <button
            id="pair-scanner-restart"
            type="button"
            className="pair-scanner-button"
            onClick={() => {
              void start();
            }}
          >
            重新打开相机
          </button>
        ) : null}
        <button
          id="pair-scanner-cancel"
          type="button"
          className="pair-scanner-button"
          onClick={() => {
            stopCamera();
            onCancel();
          }}
        >
          取消扫描
        </button>
      </div>
    </section>
  );
}
