import type { Controller, GUI } from 'lil-gui';

const DELAY_MS = 350;

/**
 * Hover tooltips for anything with a `data-tip` attribute: lil-gui controls, HUD labels,
 * buttons. One shared box that follows the cursor and stays inside the window.
 */
export function installTooltips() {
  const box = document.createElement('div');
  box.id = 'tooltip';
  document.body.appendChild(box);
  let current: Element | null = null;
  let timer = 0;
  let mouse = { x: 0, y: 0 };

  const place = () => {
    const pad = 14;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    let x = mouse.x + pad;
    let y = mouse.y + pad;
    if (x + w > window.innerWidth - 8) x = mouse.x - w - pad;
    if (y + h > window.innerHeight - 8) y = mouse.y - h - pad;
    box.style.left = `${Math.max(8, x)}px`;
    box.style.top = `${Math.max(8, y)}px`;
  };
  const hide = () => {
    clearTimeout(timer);
    current = null;
    box.classList.remove('show');
  };

  document.addEventListener('mousemove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    const target = (e.target as Element | null)?.closest?.('[data-tip]') ?? null;
    if (target !== current) {
      hide();
      if (!target || e.buttons) return;
      current = target;
      timer = window.setTimeout(() => {
        box.textContent = (target as HTMLElement).dataset.tip ?? '';
        box.classList.add('show');
        place();
      }, DELAY_MS);
    } else if (box.classList.contains('show')) {
      place();
    }
  });
  document.addEventListener('mousedown', hide);
  document.addEventListener('mouseleave', hide);
}

/** Attach a tooltip to a lil-gui controller (or folder) and return it, for chaining. */
export function tip<T extends Controller | GUI>(c: T, text: string): T {
  c.domElement.dataset.tip = text;
  return c;
}
