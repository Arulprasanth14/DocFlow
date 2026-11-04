/**
 * DocFlow Landing v4 — background particle field.
 *
 * Port of `startWave()` from the design. A grid of points displaced by three
 * summed sine waves, with a travelling bump that follows the pointer. It sits
 * on a fixed full-viewport canvas behind every section.
 *
 * Two changes from the design:
 *
 *  - It imported three from `https://unpkg.com/three@0.160.0` at runtime. This
 *    uses the installed `three@0.186`, so nothing is fetched at run time and
 *    there is only one copy of three in the bundle. The import stays dynamic so
 *    three lands in its own chunk and first paint never waits on it.
 *  - Point colours come from CSS tokens rather than being hard-coded, and
 *    `updateTheme()` re-reads them in place, so switching theme never has to
 *    rebuild the renderer.
 */

export interface WaveHandle {
  /** Advance and draw one frame. */
  frame(opts: {
    t: number;
    scroll: number;
    mouseX: number;
    mouseY: number;
    reducedMotion: boolean;
    /** True while the hero video covers the viewport — skip the draw. */
    skip: boolean;
  }): void;
  /** Re-read colour tokens after a theme change. */
  updateTheme(): void;
  dispose(): void;
}

/** Reads a `r g b`-style float triplet token into a tuple. */
function readVec3(styles: CSSStyleDeclaration, name: string, fallback: [number, number, number]) {
  const raw = styles.getPropertyValue(name).trim();
  if (!raw) return fallback;
  const parts = raw.split(/[\s,]+/).map(Number);
  return parts.length === 3 && parts.every((n) => Number.isFinite(n))
    ? (parts as [number, number, number])
    : fallback;
}

export async function createWave(
  canvas: HTMLCanvasElement,
  scopeEl: HTMLElement
): Promise<WaveHandle | null> {
  let THREE: typeof import('three');
  try {
    THREE = await import('three');
  } catch {
    return null;
  }

  let renderer: import('three').WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch {
    // No WebGL — the aurora layers behind this canvas carry the background.
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);

  const small = window.innerWidth < 768;
  const NX = small ? 90 : 170;
  const NZ = small ? 40 : 72;

  const pos = new Float32Array(NX * NZ * 3);
  let k = 0;
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NZ; j++) {
      pos[k++] = -18 + (36 * i) / (NX - 1);
      pos[k++] = 0;
      pos[k++] = -14 + (20 * j) / (NZ - 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

  const styles = getComputedStyle(scopeEl);
  const lo = readVec3(styles, '--lp-wave-lo', [0, 0.52, 0.78]);
  const hi = readVec3(styles, '--lp-wave-hi', [0.45, 0.32, 0.93]);
  const alpha = Number(styles.getPropertyValue('--lp-wave-alpha')) || 0.6;

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uT: { value: 0 },
      uM: { value: new THREE.Vector2(0, 0) },
      uS: { value: 0 },
      uPR: { value: renderer.getPixelRatio() },
      uLo: { value: new THREE.Vector3(...lo) },
      uHi: { value: new THREE.Vector3(...hi) },
      uA: { value: alpha },
    },
    vertexShader: /* glsl */ `
      uniform float uT; uniform vec2 uM; uniform float uS; uniform float uPR;
      varying float vH; varying float vD;
      void main(){
        vec3 p = position;
        float w = sin(p.x * 0.32 + uT * 0.7 + uS * 7.0) * 0.6
                + cos(p.z * 0.42 + uT * 0.55) * 0.5
                + sin((p.x + p.z) * 0.18 + uT * 0.35 - uS * 4.0) * 0.45;
        float d = distance(p.xz, vec2(uM.x * 14.0, uM.y * 6.0 - 2.0));
        w += exp(-d * d * 0.06) * 1.3 * sin(uT * 2.2 - d * 0.9);
        p.y = w;
        vH = w;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vD = -mv.z;
        gl_PointSize = uPR * (2.2 + w * 0.7) * (14.0 / vD);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uLo; uniform vec3 uHi; uniform float uA;
      varying float vH; varying float vD;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.05, r)
                * clamp(1.0 - (vD - 6.0) / 18.0, 0.0, 1.0) * uA;
        vec3 col = mix(uLo, uHi, clamp(vH * 0.45 + 0.5, 0.0, 1.0));
        gl_FragColor = vec4(col, a);
      }
    `,
  });

  scene.add(new THREE.Points(geo, mat));

  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  };
  onResize();
  window.addEventListener('resize', onResize);

  let mx = 0;
  let my = 0;
  let drawnOnce = false;

  return {
    frame({ t, scroll, mouseX, mouseY, reducedMotion, skip }) {
      mx += (mouseX - mx) * 0.05;
      my += (mouseY - my) * 0.05;

      mat.uniforms.uT.value = reducedMotion ? 0 : t;
      mat.uniforms.uS.value = scroll;
      (mat.uniforms.uM.value as import('three').Vector2).set(mx, my);

      cam.position.set(
        Math.sin(scroll * Math.PI * 2) * 4 + mx * 0.8,
        3.6 + Math.cos(scroll * Math.PI * 3) * 1.2,
        10
      );
      cam.lookAt(0, -0.5, -3);

      // Under reduced motion draw a single static frame, then stop.
      if (skip || (reducedMotion && drawnOnce)) return;
      renderer.render(scene, cam);
      drawnOnce = true;
    },

    updateTheme() {
      const s = getComputedStyle(scopeEl);
      (mat.uniforms.uLo.value as import('three').Vector3).set(
        ...readVec3(s, '--lp-wave-lo', [0, 0.52, 0.78])
      );
      (mat.uniforms.uHi.value as import('three').Vector3).set(
        ...readVec3(s, '--lp-wave-hi', [0.45, 0.32, 0.93])
      );
      mat.uniforms.uA.value = Number(s.getPropertyValue('--lp-wave-alpha')) || 0.6;
      drawnOnce = false;
    },

    dispose() {
      window.removeEventListener('resize', onResize);
      geo.dispose();
      mat.dispose();
      renderer.dispose();
    },
  };
}
