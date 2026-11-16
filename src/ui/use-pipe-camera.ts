import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_CAMERA, type Camera } from './pipe-3d';

export const CAMERA_VIEWS = {
  'Общий': DEFAULT_CAMERA,
  'Сверху': { yaw: 0.02, pitch: 1.18, zoom: 1 },
  'Вдоль': { yaw: 0.96, pitch: 0.38, zoom: 1 },
} satisfies Record<string, Camera>;

type CameraView = keyof typeof CAMERA_VIEWS;
const TRANSITION_MS = 420;

export function usePipeCamera() {
  const [camera, setCamera] = useState(DEFAULT_CAMERA);
  const [view, setView] = useState<CameraView | null>('Общий');
  const animation = useRef<number | null>(null);
  const committed = useRef(camera);

  useLayoutEffect(() => { committed.current = camera; }, [camera]);

  const stop = useCallback(() => {
    if (animation.current === null) return;
    cancelAnimationFrame(animation.current);
    animation.current = null;
    setCamera(committed.current);
    setView(null);
  }, []);

  useEffect(() => () => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
  }, []);

  function adjust(change: (current: Camera) => Camera) {
    stop();
    setView(null);
    setCamera(change);
  }

  const reset = useCallback(() => {
    stop();
    setView('Общий');
    setCamera(DEFAULT_CAMERA);
  }, [stop]);

  function select(next: CameraView) {
    stop();
    setView(next);
    const target = CAMERA_VIEWS[next];
    if (camera === target || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setCamera(target);
      return;
    }
    const start = performance.now();
    const deltaYaw = target.yaw - camera.yaw;
    const yaw = Math.atan2(Math.sin(deltaYaw), Math.cos(deltaYaw));
    function animate(time: number) {
      const fraction = Math.min(1, Math.max(0, (time - start) / TRANSITION_MS));
      if (fraction === 1) {
        animation.current = null;
        setCamera(target);
        return;
      }
      const progress = fraction * fraction * (3 - 2 * fraction);
      setCamera({
        yaw: camera.yaw + progress * yaw,
        pitch: camera.pitch + progress * (target.pitch - camera.pitch),
        zoom: camera.zoom + progress * (target.zoom - camera.zoom),
      });
      animation.current = requestAnimationFrame(animate);
    }
    animation.current = requestAnimationFrame(animate);
  }

  return { camera, view, stop, adjust, reset, select };
}
