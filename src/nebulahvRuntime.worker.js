const createDisplay = (moduleConfig, canvas) => {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    desynchronized: true,
  });
  if (!gl) throw new Error("NebulaHV requires WebGL 2 for its local display.");

  const shader = (type, source) => {
    const value = gl.createShader(type);
    gl.shaderSource(value, source);
    gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(value) || "NebulaHV display shader failed.");
    }
    return value;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
    in vec2 position;
    out vec2 uv;
    void main() {
      uv = vec2((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
    precision mediump float;
    uniform sampler2D framebufferTexture;
    in vec2 uv;
    out vec4 outputColor;
    void main() { outputColor = texture(framebufferTexture, uv).bgra; }
  `));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "NebulaHV display program failed.");
  }
  const vertices = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.useProgram(program);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let uploadBuffer = null;
  let pendingFrame = null;
  let scheduled = false;
  let lastPresentedAt = 0;
  moduleConfig.nebulahvDisplayResize = (width, height) => {
    canvas.width = width;
    canvas.height = height;
    uploadBuffer = new Uint8Array(width * height * 4);
    gl.viewport(0, 0, width, height);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, uploadBuffer,
    );
  };
  moduleConfig.nebulahvDisplayUpdate = (
    pointer, width, height, stride, x, y, updateWidth, updateHeight,
  ) => {
    pendingFrame = { pointer, width, height, stride };
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      const now = performance.now();
      if (now - lastPresentedAt < 100) return;
      lastPresentedAt = now;
      const frame = pendingFrame;
      pendingFrame = null;
      if (!frame) return;
      if (!uploadBuffer || canvas.width !== frame.width || canvas.height !== frame.height) {
        moduleConfig.nebulahvDisplayResize(frame.width, frame.height);
      }
      const heap = moduleConfig.HEAPU8;
      if (!heap) return;
      const rowBytes = frame.width * 4;
      for (let row = 0; row < frame.height; row += 1) {
        const sourceOffset = frame.pointer + row * frame.stride;
        uploadBuffer.set(heap.subarray(sourceOffset, sourceOffset + rowBytes), row * rowBytes);
      }
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height,
        gl.RGBA, gl.UNSIGNED_BYTE, uploadBuffer,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      const bitmap = canvas.transferToImageBitmap();
      self.postMessage({ type: "frame", bitmap, width: frame.width, height: frame.height }, [bitmap]);
    }, 0);
  };
};

let runtime = null;

self.onmessage = async ({ data }) => {
  if (data.type === "input") {
    runtime?.[`_${data.name}`]?.(...data.args);
    return;
  }
  if (data.type !== "start") return;

  try {
    const { qemuArguments, runtimeManifest, runtimeUrl, baseUrl } = data;
    const canvas = new OffscreenCanvas(640, 480);
    const versioned = (path) => {
      const url = new URL(path, baseUrl);
      url.searchParams.set("v", runtimeManifest.runtimeVersion);
      return url.href;
    };
    const moduleConfig = {
      arguments: qemuArguments,
      canvas,
      noInitialRun: false,
      mainScriptUrlOrBlob: runtimeUrl,
      locateFile: (path) => versioned(`${runtimeManifest.runtimeBase}${path}`),
      print: (line) => self.postMessage({ type: "print", line: String(line) }),
      printErr: (line) => self.postMessage({ type: "printErr", line: String(line) }),
      preRun: [() => {
        const files = [
          ...Object.values(runtimeManifest.firmware || {}).filter(Boolean).map((path) => ({
            source: new URL(path, baseUrl).href,
            destination: `/${path.split("/").pop()}`,
          })),
          ...["bios-256k.bin", "kvmvapic.bin", "vgabios-stdvga.bin"].map((name) => ({
            source: versioned(`${runtimeManifest.runtimeBase}${name}`),
            destination: `/${name}`,
          })),
        ];
        const dependency = "nebulahv-worker-firmware";
        moduleConfig.addRunDependency(dependency);
        Promise.all(files.map(async ({ source, destination }) => {
          const response = await fetch(source, { cache: "force-cache" });
          if (!response.ok) throw new Error(`Could not load firmware: ${source}`);
          moduleConfig.FS.writeFile(destination, new Uint8Array(await response.arrayBuffer()));
        })).then(
          () => moduleConfig.removeRunDependency(dependency),
          (error) => {
            moduleConfig.printErr(error?.message || error);
            moduleConfig.removeRunDependency(dependency);
          },
        );
      }],
      onAbort: (reason) => self.postMessage({ type: "abort", reason: String(reason) }),
      onExit: (code) => self.postMessage({ type: "exit", code }),
    };
    createDisplay(moduleConfig, canvas);
    const imported = await import(/* @vite-ignore */ runtimeUrl);
    runtime = await imported.default(moduleConfig);
    self.postMessage({ type: "started" });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.stack || error?.message || String(error) });
  }
};
