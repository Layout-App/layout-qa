import {QaViewport} from './types';

export const DEFAULT_VIEWPORT: QaViewport = {
  id: 'desktop',
  width: 1280,
  height: 900,
};

export const VIEWPORT_PRESETS: Record<string, QaViewport> = {
  desktop: DEFAULT_VIEWPORT,
  tablet: {
    id: 'tablet',
    width: 768,
    height: 1024,
  },
  mobile: {
    id: 'mobile',
    width: 390,
    height: 844,
  },
};

function cloneViewport(viewport: QaViewport): QaViewport {
  return {...viewport};
}

export function parseViewport(value?: string): QaViewport {
  const raw = (value || '').trim().toLowerCase();
  if (!raw) return cloneViewport(DEFAULT_VIEWPORT);

  const preset = VIEWPORT_PRESETS[raw];
  if (preset) return cloneViewport(preset);

  const match = raw.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) {
    throw new Error(
      `Unsupported viewport "${value}". Use desktop, tablet, mobile, or WIDTHxHEIGHT.`
    );
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(`Viewport "${value}" must use positive integer dimensions.`);
  }

  return {
    id: `${width}x${height}`,
    width,
    height,
  };
}

export function formatViewport(viewport: QaViewport) {
  return `${viewport.id} (${viewport.width}x${viewport.height})`;
}
