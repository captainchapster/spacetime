/**
 * A word with phone and tablet visitors before the simulation starts. It ray-traces every
 * pixel through curved spacetime on the GPU and is flown with a keyboard and mouse: on a
 * touch-only device it will be slow, hot and hard to control. They can still go ahead, and
 * the choice is remembered.
 */

const KEY = 'spacetime.touchOk';

/** A device whose only pointer is a finger. */
function touchOnly() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const fine = matchMedia('(any-pointer: fine)').matches;
  return (coarse && !fine) || (navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 600);
}

/** Resolves when the simulation may start. */
export function desktopGate(): Promise<void> {
  let ok = false;
  try {
    ok = localStorage.getItem(KEY) === '1';
  } catch {
    // Storage blocked: just ask.
  }
  if (ok || !touchOnly()) return Promise.resolve();
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.id = 'gate';
    box.innerHTML = `
      <div class="card">
        <h2>Best on a desktop computer</h2>
        <p>This simulation traces every pixel's light through the curved spacetime of a spinning
        black hole, live, on your graphics card. It is flown with a keyboard and mouse.</p>
        <p>On a phone or tablet it will run slowly, get warm, and the controls won't work well.</p>
        <div class="buttons">
          <a class="secondary" href="./">Back to the sandbox</a>
          <button type="button">Continue anyway</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    box.querySelector('button')!.addEventListener('click', () => {
      try {
        localStorage.setItem(KEY, '1');
      } catch {
        // Not remembered; fine.
      }
      box.remove();
      resolve();
    });
  });
}
