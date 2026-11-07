// ─────────────────────────────────────────────────────────────
// 색 변환기: 캔버스(RGB) → YUV(I420) · BT.709 · TV 범위(16~235)
//
// 압축기(특히 그래픽카드 H.264)에 RGB를 넘기면 일부 컴퓨터에서 전체 범위(0~255)로 변환하고
// 파일에는 표시하지 않아 대비가 세집니다. 직접 표준 방식으로 변환해 넘깁니다.
//
// 변환은 WebGL2, 결과로 VideoFrame(I420) 생성. WebGL2가 없으면 null.
// ─────────────────────────────────────────────────────────────
(function (root) {
  'use strict';

  // 색 정보 (WebCodecs 표기)
  const BT709_LIMITED = Object.freeze({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false });
  const BT601_LIMITED = Object.freeze({ primaries: 'bt709', transfer: 'bt709', matrix: 'smpte170m', fullRange: false });
  // 색 표시 이름 → 디코더용 색 정보
  const colorSpaceOf = tag => (tag === 'bt709-limited' ? BT709_LIMITED : tag === 'bt601-limited' ? BT601_LIMITED : null);

  const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

  // 밝기(Y): 출력 1칸(RGBA)에 이웃 픽셀 4개 → 읽는 양 1/4
  const FS_Y = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform ivec2 size;
out vec4 o;
float Y(int x, int y) {
  vec3 c = texelFetch(src, ivec2(min(x, size.x - 1), y), 0).rgb;
  return (16.0 + 219.0 * dot(c, vec3(0.2126, 0.7152, 0.0722))) / 255.0;
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  int x = q.x * 4;
  o = vec4(Y(x, q.y), Y(x + 1, q.y), Y(x + 2, q.y), Y(x + 3, q.y));
}`;

  // 색차(U, V): 2×2 평균
  const FS_UV = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform ivec2 size;
out vec4 o;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 2;
  ivec2 m = size - 1;
  vec3 c = (texelFetch(src, min(b, m), 0).rgb + texelFetch(src, min(b + ivec2(1, 0), m), 0).rgb +
            texelFetch(src, min(b + ivec2(0, 1), m), 0).rgb + texelFetch(src, min(b + ivec2(1, 1), m), 0).rgb) * 0.25;
  float u = 128.0 + 224.0 * dot(c, vec3(-0.1146, -0.3854, 0.5));
  float v = 128.0 + 224.0 * dot(c, vec3(0.5, -0.4542, -0.0458));
  o = vec4(u / 255.0, v / 255.0, 0.0, 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(gl, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  class RgbToI420 {
    constructor() {
      const c = new OffscreenCanvas(2, 2);
      const gl = c.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
      if (!gl) throw new Error('WebGL2 없음');
      this.gl = gl;
      this.pY = program(gl, FS_Y);
      this.pUV = program(gl, FS_UV);
      this.uvSize = gl.getUniformLocation(this.pUV, 'size');
      this.ySize = gl.getUniformLocation(this.pY, 'size');
      // 화면 전체를 덮는 삼각형 2개
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.srcTex = this._tex();
      this.w = 0; this.h = 0;
    }
    _tex() {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    _target(w, h) {
      const gl = this.gl, tex = this._tex();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb, w, h };
    }
    _resize(w, h) {
      const gl = this.gl;
      for (const t of [this.tY, this.tUV]) if (t) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
      this.w = w; this.h = h;
      this.cw = (w + 1) >> 1; this.ch = (h + 1) >> 1;
      this.qw = (w + 3) >> 2; // 밝기 출력 가로 칸 수
      this.tY = this._target(this.qw, h);
      this.tUV = this._target(this.cw, this.ch);
      this.rgbaY = new Uint8Array(this.qw * 4 * h);
      this.rgbaUV = new Uint8Array(this.cw * this.ch * 4);
    }
    /**
     * @param {CanvasImageSource} source  w×h 캔버스
     * @returns {VideoFrame} I420, BT.709 TV 범위
     */
    convert(source, w, h, timestamp, duration) {
      const gl = this.gl;
      if (w !== this.w || h !== this.h) this._resize(w, h);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);

      // 밝기
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tY.fb);
      gl.viewport(0, 0, this.qw, h);
      gl.useProgram(this.pY);
      gl.uniform2i(this.ySize, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, this.qw, h, gl.RGBA, gl.UNSIGNED_BYTE, this.rgbaY);
      // 색차
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tUV.fb);
      gl.viewport(0, 0, this.cw, this.ch);
      gl.useProgram(this.pUV);
      gl.uniform2i(this.uvSize, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, this.cw, this.ch, gl.RGBA, gl.UNSIGNED_BYTE, this.rgbaUV);

      // RGBA 결과 → I420 (Y → U → V)
      const ySize = w * h, cSize = this.cw * this.ch;
      const out = new Uint8Array(ySize + cSize * 2);
      const a = this.rgbaY, stride = this.qw * 4;
      if (stride === w) out.set(a.subarray(0, ySize), 0);              // 가로가 4의 배수
      else for (let r = 0; r < h; r++) out.set(a.subarray(r * stride, r * stride + w), r * w); // 줄 단위
      const b = this.rgbaUV;
      for (let i = 0, j = 0; i < cSize; i++, j += 4) { out[ySize + i] = b[j]; out[ySize + cSize + i] = b[j + 1]; }

      return new VideoFrame(out, {
        format: 'I420', codedWidth: w, codedHeight: h, timestamp, duration,
        colorSpace: BT709_LIMITED
      });
    }
  }

  // 변환기 생성 (불가 시 null)
  function createConverter() {
    try { return new RgbToI420(); } catch (_) { return null; }
  }

  // ── 보정: 캔버스 색을 16~235로 압축 ──
  // 압축기가 전체 범위로 바꾸는 컴퓨터에서 결과가 표준 TV 범위가 되도록 미리 압축
  function compressRange(ctx, w, h) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgb(219,219,219)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgb(16,16,16)';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // ── 검사: 압축기의 색 범위 확인 ──
  // 검정|빨강|흰색 그림을 압축 → 복원해 밝기 확인
  //   검정≈16, 흰색≈235 → 'limited'(정상) / 검정≈0, 흰색≈255 → 'full'
  //   TV 범위일 때 빨강 밝기로 변환식 판별: ≈63 BT.709 / ≈81 BT.601
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

  async function probeOnce(encCfg, w, h, mode, converter) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: false });
    const paint = () => {
      const t = Math.round(w / 3);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f00'; ctx.fillRect(t, 0, t, h);
      ctx.fillStyle = '#fff'; ctx.fillRect(2 * t, 0, w - 2 * t, h);
      if (mode === 'rgb-comp') compressRange(ctx, w, h);
    };
    const chunks = []; let decCfg = null, fail = false;
    const enc = new VideoEncoder({
      output: (c, meta) => {
        if (meta && meta.decoderConfig) decCfg = meta.decoderConfig;
        const d = new Uint8Array(c.byteLength); c.copyTo(d);
        chunks.push(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, data: d }));
      },
      error: () => { fail = true; }
    });
    try {
      enc.configure(encCfg);
      for (let i = 0; i < 3; i++) {
        paint();
        const ts = i * 33333;
        const vf = mode === 'yuv' ? converter.convert(canvas, w, h, ts, 33333) : new VideoFrame(canvas, { timestamp: ts, duration: 33333 });
        enc.encode(vf, { keyFrame: i === 0 });
        vf.close();
      }
      await enc.flush();
    } finally { try { enc.close(); } catch (_) {} }
    if (fail || !chunks.length || !decCfg) return null;

    let frame = null;
    const tryDecode = async hw => {
      const dec = new VideoDecoder({ output: f => { if (!frame) frame = f; else f.close(); }, error: () => {} });
      try {
        const cfg = Object.assign({}, decCfg, hw ? { hardwareAcceleration: hw } : {});
        delete cfg.colorSpace; // 변환 없이 원래 값 확인
        dec.configure(cfg);
        dec.decode(chunks[0]);
        await dec.flush();
      } catch (_) {} finally { try { dec.close(); } catch (_) {} }
    };
    await tryDecode('prefer-software');
    if (!frame) await tryDecode(null);
    if (!frame) return null;
    try {
      if (!frame.format) return null; // GPU 전용 프레임은 읽을 수 없음
      const buf = new Uint8Array(frame.allocationSize());
      const layout = await frame.copyTo(buf);
      const { offset, stride } = layout[0];
      const fh = frame.codedHeight, fw = frame.codedWidth;
      const at = (x, y) => buf[offset + Math.floor(y) * stride + Math.floor(x)];
      const black = at(fw / 6, fh * 0.5), red = at(fw / 2, fh * 0.5), white = at(fw * 5 / 6, fh * 0.5);
      let range = null;
      if (white >= 248 && black <= 8) range = 'full';
      else if (white >= 222 && white <= 246 && black >= 10 && black <= 26) range = 'limited';
      const matrix = Math.abs(red - 63) <= Math.abs(red - 81) ? '709' : '601';
      return { range, black, white, red, matrix };
    } finally { frame.close(); }
  }

  const planCache = new Map();
  /**
   * 색 처리 방식 결정
   * @returns {{mode:'yuv'|'rgb'|'rgb-comp', slow:'rgb'|'rgb-comp', tags:object, detail:string}}
   *   mode: 평소 방식 / slow: 변환기가 느리거나 실패할 때 대체 방식
   *   tags: 방식별 색 표시 ('bt709-limited' / 'bt601-limited' / 없음 = 확인 불가)
   */
  async function chooseColorPlan(encCfg, converter) {
    const key = [encCfg.codec, encCfg.width, encCfg.height, !!converter].join('|');
    if (planCache.has(key)) return Object.assign({}, planCache.get(key));
    const w = encCfg.width, h = encCfg.height;
    const probe = mode => withTimeout(probeOnce(encCfg, w, h, mode, converter).catch(() => null), 4000);
    const rgb = await probe('rgb');
    let comp = null;
    if (rgb && rgb.range === 'full') comp = await probe('rgb-comp');
    const yuv = converter ? await probe('yuv') : null;
    const slow = rgb && rgb.range === 'full' && comp && comp.range === 'limited' ? 'rgb-comp' : 'rgb';
    let mode;
    if (converter && !(yuv && yuv.range === 'full')) mode = 'yuv';
    else mode = slow;
    const tagOf = r => (r && r.range === 'limited' ? `bt${r.matrix}-limited` : null);
    const tags = { yuv: 'bt709-limited', 'rgb-comp': tagOf(comp), rgb: tagOf(rgb) };
    const fmt = r => r ? `${r.black}/${r.white}` : '?';
    const plan = { mode, slow, tags, detail: `기본 ${fmt(rgb)}${comp ? ' · 보정 ' + fmt(comp) : ''}${converter ? ' · 변환 ' + fmt(yuv) : ''}` };
    // 확인 실패(null)면 다음에 다시 검사
    if (rgb && (!converter || yuv)) planCache.set(key, plan);
    return Object.assign({}, plan);
  }

  root.ChzzkYuv = { createConverter, BT709_LIMITED, colorSpaceOf, compressRange, chooseColorPlan };
})(globalThis);
