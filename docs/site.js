var ee=`#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;function Ne(o,e,t){let r=o.split(`
`),s=e.split(`
`).filter(a=>a.trim().length>0).map(a=>{let n=/^\s*(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(a);if(!n)return`  ${a}`;let i=Number(n[1]),p=n[2],h=i-1,d=[];for(let u=Math.max(0,h-2);u<=Math.min(r.length-1,h+2);u++){let c=u===h?">":" ";d.push(`    ${c} ${String(u+1).padStart(4)} | ${r[u]??""}`)}return`  ${p}
${d.join(`
`)}`}).join(`
`);return`[${t}] \u7740\u8272\u5668\u7F16\u8BD1\u5931\u8D25\uFF1A
${s}

--- \u5B8C\u6574\u6E90\u7801 ---
${r.map((a,n)=>`${String(n+1).padStart(4)} | ${a}`).join(`
`)}`}function O(o,e,t){let r=o.createShader(e);if(!r)throw new Error("\u65E0\u6CD5\u521B\u5EFA\u7740\u8272\u5668\u5BF9\u8C61\uFF08\u4E0A\u4E0B\u6587\u53EF\u80FD\u5DF2\u4E22\u5931\uFF09");if(o.shaderSource(r,t),o.compileShader(r),!o.getShaderParameter(r,o.COMPILE_STATUS)){let s=o.getShaderInfoLog(r)??"(\u65E0\u65E5\u5FD7)";throw o.deleteShader(r),new Error(Ne(t,s,e===o.VERTEX_SHADER?"\u9876\u70B9":"\u7247\u5143"))}return r}var W=class{program;gl;uniforms=new Map;constructor(e,t){this.gl=e,this.program=t;let r=e.getProgramParameter(t,e.ACTIVE_UNIFORMS);for(let s=0;s<r;s++){let a=e.getActiveUniform(t,s);if(!a)continue;let n=e.getUniformLocation(t,a.name);if(!n)continue;this.uniforms.set(a.name,{location:n,type:a.type,size:a.size});let i=a.name.replace(/\[0\]$/,"");this.uniforms.has(i)||this.uniforms.set(i,{location:n,type:a.type,size:a.size})}}use(){return this.gl.useProgram(this.program),this}loc(e){return this.uniforms.get(e)?.location??null}float(e,t){let r=this.loc(e);return r&&this.gl.uniform1f(r,t),this}int(e,t){let r=this.loc(e);return r&&this.gl.uniform1i(r,t|0),this}vec2(e,t,r){let s=this.loc(e);return s&&this.gl.uniform2f(s,t,r),this}vec3(e,t,r,s){let a=this.loc(e);return a&&this.gl.uniform3f(a,t,r,s),this}vec3a(e,t){return this.vec3(e,t[0],t[1],t[2])}vec4(e,t,r,s,a){let n=this.loc(e);return n&&this.gl.uniform4f(n,t,r,s,a),this}vec2Array(e,t){let r=this.loc(e);return r&&this.gl.uniform2fv(r,t),this}floatArray(e,t){let r=this.loc(e);return r&&this.gl.uniform1fv(r,t),this}texture(e,t,r){let s=this.loc(e);if(!s)return this;let a=this.gl;return a.activeTexture(a.TEXTURE0+t),a.bindTexture(a.TEXTURE_2D,r),a.uniform1i(s,t),this}dispose(){this.gl.deleteProgram(this.program),this.uniforms.clear()}},F=class extends W{source;constructor(e,t,r=ee){let s=O(e,e.VERTEX_SHADER,r),a=O(e,e.FRAGMENT_SHADER,t),n=ue(e,s,a);super(e,n),this.source={vs:r,fs:t}}get debugSource(){return this.source}},H=class extends W{attribs=new Map;constructor(e,t,r,s){let a=O(e,e.VERTEX_SHADER,t),n=O(e,e.FRAGMENT_SHADER,r),i=ue(e,a,n);super(e,i);for(let p of s){let h=e.getAttribLocation(i,p);this.attribs.set(p,h)}}attrib(e){return this.attribs.get(e)??-1}};function ue(o,e,t){let r=o.createProgram();if(!r)throw new Error("\u65E0\u6CD5\u521B\u5EFA program \u5BF9\u8C61");if(o.attachShader(r,e),o.attachShader(r,t),o.linkProgram(r),o.deleteShader(e),o.deleteShader(t),!o.getProgramParameter(r,o.LINK_STATUS)){let s=o.getProgramInfoLog(r)??"(\u65E0\u65E5\u5FD7)";throw o.deleteProgram(r),new Error(`[\u94FE\u63A5] \u5931\u8D25\uFF1A${s}`)}return r}function me(o,e={}){let t={alpha:e.alpha??!1,antialias:!1,depth:!1,stencil:!1,premultipliedAlpha:!0,preserveDrawingBuffer:!1,powerPreference:e.powerPreference??"default",desynchronized:!0,failIfMajorPerformanceCaveat:!1},r=o.getContext("webgl2",t);if(!r)throw new Error("WebGL2 \u4E0D\u53EF\u7528\u3002\u8BF7\u68C0\u67E5 chrome://gpu \u7684\u786C\u4EF6\u52A0\u901F\u72B6\u6001\u3002");let s=!1;e.preferFloatTargets!==!1&&(s=r.getExtension("EXT_color_buffer_float")!==null||r.getExtension("EXT_color_buffer_half_float")!==null);let a=Be(r);return{gl:r,canvas:o,floatTargets:s,renderer:a,software:/swiftshader|llvmpipe|software|basic render/i.test(a)}}function Be(o){try{let e=o.getExtension("WEBGL_debug_renderer_info");if(e){let r=o.getParameter(e.UNMASKED_RENDERER_WEBGL);if(typeof r=="string"&&r.length>0)return r}let t=o.getParameter(o.RENDERER);return typeof t=="string"?t:"\u672A\u77E5\u6E32\u67D3\u5668"}catch{return"\u672A\u77E5\u6E32\u67D3\u5668"}}function B(o,e,t,r){let s=o.createTexture();if(!s)throw new Error("\u65E0\u6CD5\u521B\u5EFA\u7EB9\u7406");o.bindTexture(o.TEXTURE_2D,s),o.texImage2D(o.TEXTURE_2D,0,r?o.RGBA16F:o.RGBA8,e,t,0,o.RGBA,r?o.HALF_FLOAT:o.UNSIGNED_BYTE,null),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MIN_FILTER,o.LINEAR),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MAG_FILTER,o.LINEAR),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_WRAP_S,o.CLAMP_TO_EDGE),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_WRAP_T,o.CLAMP_TO_EDGE);let a=o.createFramebuffer();if(!a)throw new Error("\u65E0\u6CD5\u521B\u5EFA framebuffer");o.bindFramebuffer(o.FRAMEBUFFER,a),o.framebufferTexture2D(o.FRAMEBUFFER,o.COLOR_ATTACHMENT0,o.TEXTURE_2D,s,0);let n=o.checkFramebufferStatus(o.FRAMEBUFFER);if(n!==o.FRAMEBUFFER_COMPLETE)throw o.deleteFramebuffer(a),o.deleteTexture(s),new Error(`framebuffer \u4E0D\u5B8C\u6574\uFF1A0x${n.toString(16)}`);return o.bindFramebuffer(o.FRAMEBUFFER,null),o.bindTexture(o.TEXTURE_2D,null),{texture:s,framebuffer:a,width:e,height:t,dispose(){o.deleteFramebuffer(a),o.deleteTexture(s)}}}function V(o,e,t,r,s){return e.width===t&&e.height===r?e:(e.dispose(),B(o,t,r,s))}var z=class{gl;vao;vbo;ibo;vertexCount;indexCount;stride;constructor(e,t,r,s,a){this.gl=e,this.vertexCount=s,this.indexCount=a,this.stride=t.reduce((d,u)=>d+u.size,0);let n=e.createVertexArray(),i=e.createBuffer(),p=e.createBuffer();if(!n||!i||!p)throw new Error("\u65E0\u6CD5\u521B\u5EFA\u7F51\u683C\u7F13\u51B2");this.vao=n,this.vbo=i,this.ibo=p,e.bindVertexArray(n),e.bindBuffer(e.ARRAY_BUFFER,i),e.bufferData(e.ARRAY_BUFFER,s*this.stride*4,e.DYNAMIC_DRAW);let h=0;for(let d of t){let u=r.attrib(d.name);u>=0&&(e.enableVertexAttribArray(u),e.vertexAttribPointer(u,d.size,e.FLOAT,!1,this.stride*4,h*4)),h+=d.size}e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,p),e.bufferData(e.ELEMENT_ARRAY_BUFFER,a*2,e.DYNAMIC_DRAW),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null),e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,null)}update(e,t){let r=this.gl,s=Math.min(e.length,this.vertexCount*this.stride),a=Math.min(t.length,this.indexCount);r.bindBuffer(r.ARRAY_BUFFER,this.vbo),r.bufferSubData(r.ARRAY_BUFFER,0,e,0,s),r.bindBuffer(r.ELEMENT_ARRAY_BUFFER,this.ibo),r.bufferSubData(r.ELEMENT_ARRAY_BUFFER,0,t,0,a)}draw(e=this.indexCount,t=0){let r=this.gl;r.bindVertexArray(this.vao),r.drawElements(r.TRIANGLES,e,r.UNSIGNED_SHORT,t*2)}dispose(){let e=this.gl;e.deleteVertexArray(this.vao),e.deleteBuffer(this.vbo),e.deleteBuffer(this.ibo)}};function fe(o){let e=o.createVertexArray();if(!e)throw new Error("\u65E0\u6CD5\u521B\u5EFA VAO");return e}function D(o,e,t,r){o.bindFramebuffer(o.FRAMEBUFFER,e?e.framebuffer:null),o.viewport(0,0,e?e.width:t,e?e.height:r)}function N(o){o.drawArrays(o.TRIANGLES,0,3)}var Y=`
#define PI  3.141592653589793
#define TAU 6.283185307179586

/**
 * \u53CD\u5411 smoothstep\uFF1Ax <= e1 \u65F6\u4E3A 1\uFF0Cx >= e0 \u65F6\u4E3A 0\uFF08\u8981\u6C42 e0 > e1\uFF09\u3002
 *
 * \u5B58\u5728\u7684\u7406\u7531\uFF1AGLSL \u89C4\u8303\u660E\u8BF4 smoothstep(e0, e1, x) \u5728 e0 >= e1 \u65F6
 * **\u7ED3\u679C\u672A\u5B9A\u4E49**\u3002\u6211\u4EEC\u6709\u597D\u51E0\u5904\u9700\u8981\u300C\u5411\u4E0A\u8870\u51CF\u300D\u7684\u906E\u7F69\uFF0C
 * \u76F4\u63A5\u8C03\u6362\u53C2\u6570\u5728\u591A\u6570\u9A71\u52A8\u4E0A\u78B0\u5DE7\u80FD\u8DD1\uFF0C\u4F46\u7ED3\u679C\u53EF\u80FD\u56E0\u663E\u5361\u800C\u5F02\u3002
 */
float sstepDown(float e0, float e1, float x) {
  return 1.0 - smoothstep(e1, e0, x);
}

// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
// \u54C8\u5E0C\u4E0E\u566A\u58F0
// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float hash11(float x) {
  return fract(sin(x * 127.1) * 43758.5453);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += vnoise(p) * amp;
    norm += amp;
    p = p * 2.03 + vec2(17.3, 9.1);
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
// \u6C34\u9762
// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014

/**
 * \u7126\u6563\u3002
 *
 * \u6DF1\u6D77\u91CC\u7684\u7126\u6563\u53EA\u5728**\u9760\u8FD1\u6C34\u9762**\u7684\u5730\u65B9\u53EF\u89C1 \u2014\u2014 \u5149\u8FD8\u6CA1\u88AB\u6C34\u5438\u6536\u5B8C\u7684\u65F6\u5019\u3002
 * \u6240\u4EE5\u8C03\u7528\u65B9\u5FC5\u987B\u6309\u6DF1\u5EA6\u628A\u5B83\u4EEC\u8870\u51CF\u6389\uFF0C\u5426\u5219\u6574\u7247\u6C34\u4F53\u90FD\u5728\u95EA\uFF0C
 * \u90A3\u5C31\u4ECE\u300C\u6DF1\u6D77\u300D\u53D8\u6210\u4E86\u300C\u6E38\u6CF3\u6C60\u300D\u3002
 *
 * \u7528\u810A\u72B6\u566A\u58F0\u800C\u4E0D\u662F fbm\uFF1A\u7126\u6563\u7684\u5F62\u6001\u662F**\u7EC6\u4EAE\u7684\u7F51**\uFF0C\u4E0D\u662F\u4E91\u3002
 */
float causticNet(vec2 p, float t) {
  vec2 q = p;
  float a = 0.0;
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    vec2 off = vec2(t * (0.021 + fi * 0.011), -t * (0.016 + fi * 0.008));
    float n = fbm(q + off, 3);
    // \u6298\u53E0\u6210\u810A\uFF1A1 - |2n - 1|
    float ridge = 1.0 - abs(n * 2.0 - 1.0);
    a += ridge * ridge;
    q = q * 1.7 + vec2(5.2, 1.3);
  }
  return a * 0.5;
}

/**
 * \u4ECE\u4E0A\u65B9\u659C\u5C04\u4E0B\u6765\u7684\u5149\u67F1\u3002
 *
 * \u5173\u952E\u662F**\u8981\u5BBD\u3001\u8981\u8F6F\u3001\u8981\u5C11**\u3002\u4E0A\u4E00\u7248\u7684\u5149\u67F1\u53C8\u7A84\u53C8\u5BC6\uFF0C
 * \u7ED3\u679C\u753B\u9762\u50CF\u88AB\u5212\u4E86\u5F88\u591A\u9053 \u2014\u2014 \u6DF1\u6D77\u7684\u5149\u67F1\u5E94\u8BE5\u662F\u4E09\u4E24\u6761\u6A21\u7CCA\u7684\u5BBD\u5E26\u3002
 */
float lightShaft(vec2 uv, float t, float seed) {
  // \u659C\u5411\u5750\u6807\uFF1A\u5149\u67F1\u987A\u7740\u8FD9\u4E2A\u8F74\u5206\u5C42
  float x = uv.x + uv.y * 0.42;
  float sum = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float s = fi * 7.31 + seed;
    float drift = sin(t * 0.018 + s) * 0.06;
    float band = fract(x * (0.6 + fi * 0.37) + drift + s * 0.31);
    // \u4E00\u4E2A\u5F88\u8F6F\u7684\u949F\u5F62
    float w = smoothstep(0.0, 0.5, band) * smoothstep(1.0, 0.5, band);
    sum += pow(w, 2.2);
  }
  return sum / 3.0;
}

/**
 * \u60AC\u6D6E\u5FAE\u7C92\uFF08\u6D77\u96EA\uFF09\u3002
 *
 * \u6DF1\u8272\u573A\u666F\u91CC\u8FD9\u662F**\u6027\u4EF7\u6BD4\u6700\u9AD8\u7684\u4E00\u4E2A\u5143\u7D20** \u2014\u2014 \u51E0\u4E2A\u53D1\u5149\u5C0F\u70B9\u5C31\u80FD
 * \u8BA9\u6574\u7247\u6C34\u6709\u4F53\u79EF\u611F\u548C\u7EB5\u6DF1\u611F\uFF0C\u800C\u6210\u672C\u51E0\u4E4E\u4E3A\u96F6\u3002
 *
 * \u7528\u683C\u70B9\u800C\u4E0D\u662F\u9010\u7C92\u5B50\u5FAA\u73AF\uFF1A\u6BCF\u683C\u81F3\u591A\u4E00\u4E2A\u7C92\u5B50\uFF0C\u4FBF\u5B9C\u4E14\u89C6\u89C9\u4E0A\u591F\u7528\u3002
 */
float marineSnow(vec2 uv, float t, float density) {
  vec2 p = vec2(uv.x, uv.y * 0.6);
  vec2 gv = p * density;
  vec2 id = floor(gv);
  vec2 f = fract(gv) - 0.5;

  float h = hash21(id);
  if (h > 0.34) return 0.0; // \u5927\u90E8\u5206\u683C\u5B50\u662F\u7A7A\u7684 \u2014\u2014 \u7A00\u758F\u624D\u6709\u6DF1\u6D77\u611F

  float fall = fract(h * 13.7 + t * (0.006 + h * 0.010));
  vec2 pos = vec2((h - 0.5) * 0.7 + sin(t * 0.1 + h * 20.0) * 0.06, fall - 0.5);

  float d = length(f - pos);
  float r = 0.012 + h * 0.010;
  return smoothstep(r, 0.0, d) * (0.35 + h * 0.65);
}

// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
// \u901A\u7528
// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
`;var te=1,oe=2,re=4,ne=8,ae=16,G=ee,he=`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uResolution;
uniform float uAspect;
uniform float uTime;
uniform float uSeed;
uniform float uIntro;

uniform vec3  uWaterTop;
uniform vec3  uWaterDeep;
uniform vec3  uLight;
uniform vec3  uCaustic;

uniform float uAmbient;
uniform float uTurbidity;
uniform int   uDetail;
uniform int   uLayers;
/** \u8FDC\u666F\u79CD\u7C7B\uFF1A0 \u5F00\u9614 / 1 \u6D77\u6C9F / 2 \u6C89\u964D\u96EA\u539F / 3 \u70ED\u6CC9 / 4 \u9057\u8FF9 */
uniform int   uBackdrop;

${Y}

/**
 * \u6DF1\u5EA6\u30020 = \u6C34\u9762\uFF0C1 = \u753B\u9762\u5E95\u90E8\u3002
 *
 * \u7528 y \u76F4\u63A5\u5F53\u6DF1\u5EA6\u662F\u4E00\u79CD**\u98CE\u683C\u5316**\u5904\u7406 \u2014\u2014 \u771F\u5B9E\u6DF1\u5EA6\u9700\u8981\u6444\u50CF\u673A\u4E0E\u573A\u666F\u51E0\u4F55\uFF0C
 * \u800C\u6211\u4EEC\u662F\u4E00\u4E2A\u6B63\u5BF9\u6C34\u4F53\u7684\u4E8C\u7EF4\u89C6\u53E3\u3002\u5BF9\u6DF1\u6D77\u610F\u8C61\u6765\u8BF4\uFF0C\u300C\u8D8A\u5F80\u4E0B\u8D8A\u6DF1\u300D
 * \u8FD9\u4E2A\u76F4\u89C9\u8DB3\u591F\u51C6\u786E\uFF0C\u800C\u4E14\u5B8C\u5168\u907F\u514D\u4E86\u4E09\u7EF4\u7684\u590D\u6742\u5EA6\u3002
 */
float depthAt(vec2 t) {
  return clamp(t.y, 0.0, 1.0);
}

/**
 * \u8FDC\u666F\u3002
 *
 * ## \u4E09\u6761\u786C\u7EA6\u675F
 *
 * **\u4E00\u3001\u526A\u5F71\u5FC5\u987B\u662F\u8FD1\u9ED1\u7684\u3002** \u8FDC\u666F\u6BD4\u8FD1\u666F\u4EAE\u4F1A\u8BA9\u753B\u9762**\u5931\u53BB\u7EB5\u6DF1** \u2014\u2014
 * \u4EBA\u5BF9\u8DDD\u79BB\u7684\u611F\u77E5\u5F88\u5927\u4E00\u90E8\u5206\u6765\u81EA\u300C\u8FDC\u5904\u7684\u4E1C\u897F\u88AB\u6C34\u5438\u6536\u5F97\u66F4\u72E0\u300D\u3002
 *
 * **\u4E8C\u3001\u53EA\u5728\u8FB9\u7F18\u7559\u4E00\u70B9\u70B9\u88AB\u7167\u4EAE\u3002** \u526A\u5F71\u5E73\u6D82\u4F1A\u50CF\u8D34\u7EB8\uFF1B
 * \u53EA\u6709\u5DE6\u7F18\uFF08\u671D\u5411\u5149\u6E90\u90A3\u4E00\u4FA7\uFF09\u6709\u4E00\u7EBF\u5FAE\u5149\uFF0C\u5B83\u624D\u4F1A\u4ECE\u6C34\u91CC\u300C\u5207\u300D\u51FA\u6765\u3002
 *
 * **\u4E09\u3001\u4EAE\u5EA6\u4E0A\u9650\u7531\u8C03\u7528\u65B9\u515C\u5E95\u3002** \u8FD9\u4E00\u5C42\u662F**\u80CC\u666F**\uFF0C
 * \u751F\u7269\u624D\u662F\u4E3B\u89D2\u3002\u8FDC\u666F\u7684\u5BF9\u6BD4\u5EA6\u7A0D\u5FAE\u9AD8\u4E00\u70B9\uFF0C\u753B\u9762\u7ACB\u523B\u53D8\u5435\u3002
 *
 * \u8F93\u51FA\u4E24\u4E2A\u91CF\uFF1A
 *   cover  \u906E\u6321\u7A0B\u5EA6\uFF0C\u7528\u6765\u628A\u6C34\u4F53\u989C\u8272\u6362\u6389\uFF08\u4E0D\u662F\u53E0\u52A0\uFF09
 *   tint   \u52A0\u5728\u906E\u6321\u7ED3\u679C\u4E0A\u7684\u989C\u8272\uFF08\u8FB9\u7F18\u5149\u3001\u70ED\u6CC9\u7684\u4F59\u6656\uFF09
 */
void backdropLayer(
  int kind,
  vec2 t,
  float aspect,
  float time,
  float seed,
  vec3 light,
  float ambient,
  out float cover,
  out vec3 tint
) {
  cover = 0.0;
  tint = vec3(0.0);
  if (kind == 0) return; // \u5F00\u9614\u6C34\u57DF\uFF1A\u4EC0\u4E48\u90FD\u6CA1\u6709\uFF0C\u6700\u5B89\u9759

  float x = t.x * aspect;

  if (kind == 1) {
    // \u2014\u2014\u2014 \u6D77\u6C9F\uFF1A\u53F3\u4FA7\u4E00\u9053\u9ED1\u538B\u538B\u7684\u5D16\u58C1 \u2014\u2014\u2014
    // \u8FB9\u7F18\u7528 fbm \u6270\u52A8\uFF0C\u514D\u5F97\u662F\u4E00\u6761\u6570\u5B66\u76F4\u7EBF
    // \u5D16\u58C1\u63A8\u5F97\u66F4\u8FDC\u4E00\u4E9B\uFF1A\u5360\u6EE1\u53F3\u534A\u5C4F\u4F1A\u663E\u5F97\u5B83\u5F88\u8FD1\uFF0C\u800C\u300C\u8FDC\u5904\u7684\u5D16\u58C1\u300D
    // \u624D\u662F\u8FD9\u4E00\u5C42\u60F3\u8981\u7684
    float wob = (fbm(vec2(t.y * 2.6 + seed * 1.7, 5.3), 3) - 0.5) * 0.46;
    // \u518D\u53E0\u4E00\u5C42\u9AD8\u9891\uFF0C\u514D\u5F97\u8FB9\u7F18\u53EA\u662F\u4E00\u6761\u7F13\u6162\u8D77\u4F0F\u7684\u66F2\u7EBF
    wob += (fbm(vec2(t.y * 9.0 + seed, 17.0), 2) - 0.5) * 0.07;
    float edge = 0.74 + wob;
    cover = smoothstep(edge - 0.02, edge + 0.02, x);
    // \u53EA\u6709\u671D\u5411\u5149\u6E90\u7684\u90A3\u4E00\u4FA7\u6709\u8FB9\u7F18\u5149\uFF0C\u800C\u4E14**\u6CBF\u9AD8\u5EA6\u660E\u6697\u4E0D\u5747** \u2014\u2014
    // \u4E00\u6761\u5747\u5300\u7684\u4EAE\u8FB9\u4F1A\u50CF\u753B\u4E0A\u53BB\u7684\u63CF\u8FB9\uFF0C\u4E0D\u5747\u5300\u624D\u50CF\u5CA9\u4F53\u88AB\u659C\u7167
    float lit = 0.45 + 0.55 * fbm(vec2(t.y * 3.4 + seed, 11.0), 3);
    float rim = smoothstep(edge - 0.045, edge, x) * (1.0 - smoothstep(edge, edge + 0.07, x));
    // \u5D16\u58C1\u5185\u90E8\u6781\u6DE1\u7684\u8D77\u4F0F\uFF0C\u6697\u793A\u5CA9\u4F53\u800C\u4E0D\u662F\u4E00\u5757\u7EAF\u9ED1\u677F
    float rock = fbm(vec2(x * 11.0, t.y * 7.0 + seed), 3);
    tint = light * (rim * lit * 0.45 + rock * 0.03 * cover) * ambient;
    return;
  }

  if (kind == 2) {
    // \u2014\u2014\u2014 \u6C89\u964D\u96EA\u539F\uFF1A\u5BC6\u96C6\u7684\u6709\u673A\u788E\u5C51\u5728\u7F13\u7F13\u843D\u4E0B \u2014\u2014\u2014
    // \u8FD9\u4E00\u5C42\u4E0D\u906E\u6321\uFF0C\u5B83\u662F**\u52A0**\u4E0A\u53BB\u7684\u3002\u5BC6\u5EA6\u6BD4\u9ED8\u8BA4\u7684\u6D77\u96EA\u9AD8\u5F97\u591A\uFF0C
    // \u4E8E\u662F\u6574\u7247\u6C34\u770B\u8D77\u6765\u50CF\u5728\u4E0B\u96EA \u2014\u2014 \u8FD9\u662F\u6700\u6DF1\u7684\u4E00\u79CD\u300C\u4E0B\u96EA\u611F\u300D\u3002
    vec2 p = vec2(x, t.y * 0.55);
    vec2 gv = p * 62.0;
    vec2 id = floor(gv);
    vec2 f = fract(gv) - 0.5;
    float h = hash21(id);
    if (h < 0.62) return;
    float fall = fract(h * 13.7 + time * (0.004 + h * 0.006));
    vec2 pos = vec2((h - 0.5) * 0.75 + sin(time * 0.08 + h * 20.0) * 0.08, fall - 0.5);
    float d = length(f - pos);
    float mote = smoothstep(0.05 + h * 0.03, 0.0, d) * (0.3 + h * 0.7);
    // \u8D8A\u6DF1\u8D8A\u6697\uFF0C\u4F46\u6574\u4F53\u6BD4\u9ED8\u8BA4\u6D77\u96EA\u4EAE\u4E00\u6863
    tint = mix(light, uCaustic, 0.35) * mote * 0.30 * (1.0 - t.y * 0.55);
    return;
  }

  if (kind == 3) {
    // \u2014\u2014\u2014 \u70ED\u6CC9\u55B7\u53E3\uFF1A\u51E0\u7F15\u4E0A\u5347\u7684\u9ED1\u70DF \u2014\u2014\u2014
    // \u300C\u9ED1\u70DF\u300D\u7684\u5173\u952E\u662F\u5B83**\u6BD4\u6C34\u66F4\u9ED1**\uFF1A\u906E\u6321\u6C34\u4F53\uFF0C\u4F46\u81EA\u5DF1\u4E0D\u53D1\u5149\u3002
    // \u53EA\u5728\u6700\u5E95\u90E8\u6709\u4E00\u70B9\u70ED\u6DB2\u53E3\u7684\u4F59\u6656\u3002
    float plume = 0.0;
    float glow = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float cx = 0.22 + fi * 0.27 + (hash11(fi * 3.7 + seed) - 0.5) * 0.10;
      // \u70DF\u67F1\u5F80\u4E0A\u6563\u5F00
      float spread = 0.018 + t.y * 0.10;
      float dx = (x - cx) / spread;
      float n = fbm(vec2(dx * 1.7, t.y * 3.4 + time * 0.05 + fi * 5.0), 3);
      // \u5E95\u6D53\u4E0A\u6DE1
      float body = exp(-dx * dx) * smoothstep(1.05, 0.18, t.y) * smoothstep(0.28, 0.62, n);
      plume = max(plume, body);
      // \u55B7\u53E3\u672C\u8EAB\uFF1A\u8D34\u7740\u753B\u9762\u5E95\u90E8\u4E00\u70B9\u70B9\u6696\u5149\uFF08\u70ED\u7684\u77FF\u7269\u6C34\u5728\u53D1\u5149\uFF09
      glow = max(glow, exp(-dx * dx * 3.0) * smoothstep(0.14, 0.02, t.y));
    }
    cover = clamp(plume, 0.0, 0.85);
    tint = light * (glow * 0.55 + plume * 0.05) * ambient;
    return;
  }

  // \u2014\u2014\u2014 \u9057\u8FF9\uFF1A\u51E0\u6839\u503E\u9893\u7684\u67F1\u5B50 \u2014\u2014\u2014
  float body = 0.0;
  float rim = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float cx = 0.16 + fi * 0.20 + (hash11(fi * 5.3 + seed) - 0.5) * 0.07;
    float w = 0.018 + hash11(fi * 9.1 + seed) * 0.016;
    // \u65AD\u53E3\u9AD8\u5EA6\u4E0D\u4E00 \u2014\u2014 \u9F50\u5237\u5237\u4E00\u6837\u9AD8\u5C31\u4E0D\u50CF\u5E9F\u589F\u4E86
    float top = 0.34 + hash11(fi * 13.7 + seed) * 0.26;
    // \u67F1\u5B50\u8D8A\u5F80\u4E0B\u8D8A\u6536\uFF08\u900F\u89C6\uFF09
    float halfW = w * (1.0 - t.y * 0.25);
    float inside = step(abs(x - cx), halfW) * step(top, t.y);
    body = max(body, inside);
    float edge = smoothstep(halfW + 0.006, halfW, abs(x - cx));
    rim = max(rim, edge * step(top, t.y));
  }
  cover = body;
  tint = light * (rim * 0.30 + body * 0.02) * ambient;
}

void main() {
  vec2 uv = vUv;
  vec2 t = vec2(uv.x, 1.0 - uv.y); // \u8F6C\u6210\u300C\u4E0A = 0\u300D
  float depth = depthAt(t);

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 1. \u6C34\u4F53\u672C\u8EAB\u7684\u5782\u76F4\u6E10\u53D8 \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  //
  // \u6307\u6570 0.65 \u8BA9\u4E0A\u534A\u90E8\u5206\u4FDD\u6301\u8F83\u4EAE\u7684\u9752\uFF0C\u4E0B\u534A\u90E8\u5206\u8FC5\u901F\u6C89\u5165\u9ED1 \u2014\u2014
  // \u7EBF\u6027\u6E10\u53D8\u4F1A\u8BA9\u6574\u7247\u6C34\u90FD\u53D1\u7070\uFF0C\u6CA1\u6709\u300C\u6DF1\u6E0A\u300D\u7684\u611F\u89C9\u3002
  float g = pow(depth, 0.65);
  vec3 col = mix(uWaterTop, uWaterDeep, g);

  // \u4E00\u70B9\u5927\u5C3A\u5EA6\u7684\u6C34\u8272\u4E0D\u5747\uFF0C\u907F\u514D\u6E10\u53D8\u8FC7\u4E8E\u300C\u6570\u5B66\u300D
  float mottle = fbm(t * vec2(uAspect, 1.0) * 2.1 + uSeed, 3) - 0.5;
  col += mottle * uWaterTop * 0.16 * (1.0 - g * 0.7);

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 2. \u9876\u90E8\u5149\u6C60 \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  //
  // \u5149\u6E90\u5728\u753B\u9762\u4E0A\u65B9\u7565\u504F\u5DE6\u3002\u8FD9\u662F\u6574\u4E2A\u573A\u666F\u552F\u4E00\u7684\u7167\u660E\u6765\u6E90\u3002
  vec2 lightPos = vec2(0.42 * uAspect, -0.28);
  vec2 lp = vec2(t.x * uAspect, t.y) - lightPos;
  float pool = exp(-dot(lp, lp) * 1.35);
  col += uLight * pool * uAmbient * 0.30;

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 3. \u7126\u6563 \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  //
  // \u53EA\u5728\u9760\u8FD1\u6C34\u9762\u7684\u5730\u65B9\u53EF\u89C1\u3002\u8870\u51CF\u7528 pow(depth, 3) \u800C\u4E0D\u662F\u7EBF\u6027 \u2014\u2014
  // \u5149\u88AB\u6C34\u5438\u6536\u5F97\u5F88\u5FEB\uFF0C\u7126\u6563\u7684\u5B58\u5728\u8303\u56F4\u6BD4\u76F4\u89C9\u4E0A\u7A84\u5F97\u591A\u3002
  if ((uLayers & ${oe}) != 0) {
    float near = pow(1.0 - depth, 3.0);
    if (near > 0.002) {
      float c = causticNet(vec2(t.x * uAspect, t.y * 0.55) * 4.4, uTime);
      // \u810A\u72B6\u566A\u58F0\u672C\u8EAB\u5BF9\u6BD4\u5EA6\u5F88\u9AD8\uFF0C\u8FD9\u91CC\u538B\u5230\u5F88\u4F4E\u7684\u7CFB\u6570 \u2014\u2014 \u7126\u6563\u662F**\u6697\u793A**\uFF0C
      // \u4E0D\u662F\u4E3B\u4F53\u3002\u8C03\u9AD8\u4E00\u70B9\u753B\u9762\u7ACB\u523B\u53D8\u5F97\u50CF\u6E38\u6CF3\u6C60\u3002
      col += uCaustic * c * near * uAmbient * 0.34;
    }
  }

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 4. \u5149\u67F1 \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  if ((uLayers & ${re}) != 0) {
    float shaft = lightShaft(vec2(t.x * uAspect, t.y), uTime, uSeed);
    // \u8D8A\u5F80\u4E0B\u8D8A\u6563\u8D8A\u6DE1
    float falloff = pow(1.0 - depth, 1.7);
    col += uLight * shaft * falloff * uAmbient * 0.16;
  }

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 5. \u6D77\u96EA \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  //
  // \u6DF1\u8272\u573A\u666F\u91CC\u6027\u4EF7\u6BD4\u6700\u9AD8\u7684\u5143\u7D20\uFF1A\u51E0\u4E2A\u53D1\u5149\u5C0F\u70B9\u5C31\u6491\u51FA\u4E86\u4F53\u79EF\u611F\u3002
  if ((uLayers & ${ne}) != 0) {
    float density = uDetail >= 2 ? 34.0 : 20.0;
    float snow = marineSnow(vec2(t.x * uAspect, t.y), uTime, density);
    // \u9760\u8FD1\u6C34\u9762\u7684\u5FAE\u7C92\u88AB\u9876\u5149\u7167\u4EAE\uFF0C\u6DF1\u5904\u7684\u53EA\u7559\u4E00\u70B9\u4F59\u5149
    col += mix(uLight, uCaustic, 0.4) * snow * (1.0 - depth * 0.75) * 0.30;
  }

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 6. \u6C34\u9762 \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  if ((uLayers & ${te}) != 0) {
    // \u4E00\u6761\u5F88\u6DE1\u7684\u6C34\u9762\u7EBF + \u6781\u7A84\u7684\u9AD8\u5149\u3002\u6DF1\u5904\u770B\u6C34\u9762\u672C\u6765\u5C31\u51E0\u4E4E\u770B\u4E0D\u89C1\uFF0C
    // \u8FD9\u91CC\u7684\u5904\u7406\u662F\u300C\u6697\u793A\u4E0A\u9762\u6709\u6C34\u9762\u300D\uFF0C\u4E0D\u662F\u753B\u4E00\u6761\u8FB9\u3002
    float wave = sin(t.x * uAspect * 7.0 + uTime * 0.35) * 0.0016
               + sin(t.x * uAspect * 3.1 - uTime * 0.22) * 0.0026;
    float line = smoothstep(0.010, 0.0, abs(t.y - 0.030 - wave));
    col += uLight * line * 0.10 * uAmbient;
  }

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 6.5 \u8FDC\u666F \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  //
  // \u653E\u5728\u6C34\u4F53\u4E0E\u5149\u4E4B\u540E\u3001\u6697\u89D2\u4E4B\u524D\uFF1A\u8FDC\u666F\u8981\u88AB\u6C34\u5438\u6536\uFF08\u6240\u4EE5\u53D7\u6D51\u6D4A\u5EA6\u5F71\u54CD\uFF09\uFF0C
  // \u4F46\u4E5F\u8981\u88AB\u6697\u89D2\u538B\u4F4F\uFF08\u6240\u4EE5\u4E0D\u80FD\u653E\u5230\u6700\u540E\uFF09\u3002
  {
    float cover;
    vec3 tint;
    backdropLayer(uBackdrop, t, uAspect, uTime, uSeed, uLight, uAmbient, cover, tint);
    if (cover > 0.001) {
      // \u906E\u6321\u7528\u7684\u662F\u300C\u66F4\u9ED1\u7684\u6C34\u300D\uFF0C\u4E0D\u662F\u7EAF\u9ED1 \u2014\u2014 \u7EAF\u9ED1\u5728\u6697\u8272\u80CC\u666F\u4E0A\u4F1A\u663E\u5F97\u50CF\u6316\u4E86\u4E2A\u6D1E
      vec3 occluded = uWaterDeep * 0.28;
      col = mix(col, occluded, cover);
    }
    col += tint;
  }

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 7. \u6D51\u6D4A\u4E0E\u6697\u89D2 \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  //
  // \u6D51\u6D4A\u5EA6\u5728\u8FD9\u91CC\u7684\u4F5C\u7528\u53D8\u4E86\uFF1A\u4E0D\u518D\u662F\u300C\u8FDC\u5904\u7684\u96FE\u300D\uFF0C\u800C\u662F**\u6574\u4F53\u538B\u6697**\u3002
  // \u6DF1\u6D77\u91CC\u6C34\u672C\u8EAB\u5C31\u662F\u5438\u6536\u4ECB\u8D28\u3002
  col *= mix(1.0, 0.72, uTurbidity);

  if ((uLayers & ${ae}) != 0) {
    vec2 vp = (uv - 0.5) * vec2(1.0, 0.86);
    float vig = 1.0 - smoothstep(0.34, 0.92, length(vp));
    col *= mix(0.42, 1.0, vig);
  }

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 8. \u5F00\u573A \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  // \u4ECE\u66F4\u9ED1\u7684\u5730\u65B9\u4EAE\u8D77\u6765\u3002\u6DF1\u8272\u573A\u666F\u7684\u5F00\u573A\u4E0D\u9700\u8981\u300C\u751F\u957F\u300D\uFF0C\u53EA\u9700\u8981\u300C\u70B9\u4EAE\u300D\u3002
  col *= mix(0.0, 1.0, clamp(uIntro, 0.0, 1.0));

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 9. \u6296\u52A8 \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  //
  // \u89C1\u6587\u4EF6\u5934\u7684\u8BF4\u660E\uFF1A\u6697\u8272\u6E10\u53D8\u5728 8 \u4F4D\u8272\u6DF1\u4E0B\u4F1A\u5E26\u72B6\u5206\u5C42\u3002
  // \u5E45\u5EA6\u53D6 1/255 \u91CF\u7EA7 \u2014\u2014 \u8DB3\u591F\u6253\u6563\u91CF\u5316\u8BEF\u5DEE\uFF0C\u53C8\u5B8C\u5168\u770B\u4E0D\u89C1\u566A\u70B9\u3002
  float dither = (hash21(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5) / 255.0;

  fragColor = vec4(col + dither, 1.0);
}
`;var de=`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform float uThreshold;
uniform float uKnee;

void main() {
  vec3 c = texture(uScene, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));

  // \u8F6F\u9608\u503C\uFF1A\u5728 [threshold, threshold + knee] \u4E4B\u95F4\u5E73\u6ED1\u8FC7\u6E21\u3002
  // \u786C\u9608\u503C\u4F1A\u5728\u4EAE\u90E8\u8FB9\u7F18\u7559\u4E0B\u4E00\u5708\u7A81\u5140\u7684\u5207\u7EBF\u3002
  float w = smoothstep(uThreshold, uThreshold + uKnee, l);

  fragColor = vec4(c * w, 1.0);
}
`,be=`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uDir;

void main() {
  const float w0 = 0.227027;
  const float w1 = 0.194594;
  const float w2 = 0.121622;
  const float w3 = 0.054054;
  const float w4 = 0.016216;

  vec3 sum = texture(uSource, vUv).rgb * w0;
  sum += texture(uSource, vUv + uDir * 1.0).rgb * w1;
  sum += texture(uSource, vUv - uDir * 1.0).rgb * w1;
  sum += texture(uSource, vUv + uDir * 2.0).rgb * w2;
  sum += texture(uSource, vUv - uDir * 2.0).rgb * w2;
  sum += texture(uSource, vUv + uDir * 3.0).rgb * w3;
  sum += texture(uSource, vUv - uDir * 3.0).rgb * w3;
  sum += texture(uSource, vUv + uDir * 4.0).rgb * w4;
  sum += texture(uSource, vUv - uDir * 4.0).rgb * w4;

  fragColor = vec4(sum, 1.0);
}
`,pe=`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;

uniform vec4  uTankRect;
uniform float uTime;
uniform float uBloomStrength;
uniform float uOpacity;
/** \u6C34\u9762\u5728\u7F38\u5185\u7684 y\u3002\u6C34\u9762\u4E4B\u4E0A\u662F\u7A7A\u6C14\uFF0C\u4E0D\u8BE5\u548C\u6C34\u91CC\u4E00\u6837\u4EAE\u3002 */
uniform float uWaterLine;

${Y}

void main() {
  // \u7F38\u5185\u5750\u6807\u3002\u77E9\u5F62\u4E4B\u5916\u8F93\u51FA\u900F\u660E \u2014\u2014 \u8986\u76D6\u5C42\u8981\u80FD\u548C\u9875\u9762\u5408\u6210\u3002
  vec2 t = (vUv - uTankRect.xy) / max(vec2(1e-5), uTankRect.zw);
  float inside =
    step(0.0, t.x) * step(t.x, 1.0) * step(0.0, t.y) * step(t.y, 1.0);

  vec3 col = texture(uScene, vUv).rgb;
  col += texture(uBloom, vUv).rgb * uBloomStrength;

  if (uWaterLine > 0.0) {
    float above = smoothstep(uWaterLine, uWaterLine * 0.25, t.y);
    col *= mix(1.0, 0.55, above);
  }

  // \u6296\u52A8\uFF1A\u6697\u8272\u6E10\u53D8\u5728 8 \u4F4D\u8272\u6DF1\u4E0B\u4F1A\u5E26\u72B6\u5206\u5C42\u3002
  // \u5E45\u5EA6\u53D6 1/255 \u91CF\u7EA7 \u2014\u2014 \u8DB3\u591F\u6253\u6563\u91CF\u5316\u8BEF\u5DEE\uFF0C\u53C8\u5B8C\u5168\u770B\u4E0D\u89C1\u566A\u70B9\u3002
  float dither = (hash21(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5) / 255.0;

  float alpha = uOpacity * inside;

  // \u26A0\uFE0F \u5FC5\u987B**\u9884\u4E58**\u3002
  //
  // \u753B\u5E03\u662F\u7528 premultipliedAlpha: true \u5EFA\u7684\uFF0C\u6D4F\u89C8\u5668\u4F1A\u6309
  //     result = canvas.rgb + page.rgb * (1 - canvas.a)
  // \u5408\u6210\u3002\u5982\u679C\u8FD9\u91CC\u5199 vec4(col, alpha)\uFF08\u975E\u9884\u4E58\uFF09\uFF0C\u5B9E\u9645\u6548\u679C\u5C31\u53D8\u6210
  //     result = col + page.rgb * (1 - alpha)
  // \u2014\u2014 \u4E5F\u5C31\u662F**\u52A0\u6CD5**\uFF1A\u751F\u7269\u7684\u8F89\u5149\u4F1A\u76F4\u63A5\u52A0\u5230\u7F51\u9875\u4E0A\uFF0C\u628A\u9875\u9762\u63D0\u4EAE\u3002
  // \u8FD9\u6B63\u597D\u662F\u8986\u76D6\u5C42\u6700\u4E0D\u8BE5\u505A\u7684\u4E8B\u3002
  //
  // \u5199\u6210 vec4(col * alpha, alpha) \u624D\u662F\u6807\u51C6\u7684 source-over\uFF1A
  // \u7F51\u9875\u53EA\u4F1A\u88AB\u538B\u6697\uFF0C\u4E0D\u4F1A\u88AB\u63D0\u4EAE\u3002
  fragColor = vec4((col + dither) * alpha, alpha);
}
`;var se=[{name:"aSpine",size:1},{name:"aLocal",size:2},{name:"aBody",size:2},{name:"aFlags",size:2},{name:"aEdge",size:1},{name:"aKind",size:1}],T=9,ye=0,P=1,Ge=2,$=24,k=1400,C=4096,ve=[1,.86,.58,.2,-.2,-.58,-.86,-1],X=[1,1.12,1.26,1.43,1.63,1.88,2.2,2.6],R={lantern:{name:"lantern",kind:"fish",label:"\u706F\u7B3C\u9C7C",length:.112,height:.0158,profile:[[0,.3],[.07,.74],[.17,.95],[.3,1],[.48,.9],[.66,.68],[.84,.48],[1,.31]],segments:16,tailSpan:1.7,tailFork:.5,dorsal:.5,dorsalStart:.36,pectoral:.45,photophores:7,weight:1.35},angler:{name:"angler",kind:"fish",label:"\u9B9F\u9C47",length:.15,height:.028,profile:[[0,.44],[.09,.86],[.22,1],[.4,.97],[.58,.74],[.76,.5],[.9,.36],[1,.28]],segments:18,tailSpan:1.2,tailFork:.1,dorsal:.26,dorsalStart:.42,pectoral:.6,photophores:0,weight:.35},hatchet:{name:"hatchet",kind:"fish",label:"\u65A7\u5934\u9C7C",length:.08,height:.019,profile:[[0,.34],[.08,.82],[.2,1],[.36,.98],[.56,.72],[.76,.46],[1,.3]],segments:14,tailSpan:1.5,tailFork:.4,dorsal:.32,dorsalStart:.3,pectoral:.75,photophores:5,weight:.95},ribbon:{name:"ribbon",kind:"fish",label:"\u6DF1\u6D77\u5E26\u9C7C",length:.205,height:.0165,profile:[[0,.36],[.08,.76],[.22,.9],[.45,.94],[.68,.88],[.86,.76],[1,.52]],segments:20,tailSpan:1,tailFork:.2,dorsal:.8,dorsalStart:.14,pectoral:.28,photophores:11,weight:.45},moonjelly:{name:"moonjelly",kind:"jelly",label:"\u6D77\u6708\u6C34\u6BCD",length:.16,height:.035,profile:[],segments:14,tailSpan:0,tailFork:0,dorsal:0,dorsalStart:0,pectoral:0,photophores:0,tentacles:9,bellRings:6,weight:.75},lighthouse:{name:"lighthouse",kind:"jelly",label:"\u706F\u5854\u6C34\u6BCD",length:.1,height:.028,profile:[],segments:10,tailSpan:0,tailFork:0,dorsal:0,dorsalStart:0,pectoral:0,photophores:0,tentacles:5,bellRings:5,weight:.55}},xe=["lantern","angler","hatchet","ribbon","moonjelly","lighthouse"];function Ue(o){let e=o.length;if(e===0)return()=>0;if(e===1){let n=o[0];return()=>n[1]}let t=new Float64Array(e),r=new Float64Array(e);for(let n=0;n<e;n++)t[n]=o[n][0],r[n]=o[n][1];let s=new Float64Array(e-1);for(let n=0;n<e-1;n++){let i=t[n+1]-t[n];s[n]=i>1e-9?(r[n+1]-r[n])/i:0}let a=new Float64Array(e);a[0]=s[0],a[e-1]=s[e-2];for(let n=1;n<e-1;n++)a[n]=(s[n-1]+s[n])*.5;for(let n=0;n<e-1;n++){let i=s[n];if(i===0){a[n]=0,a[n+1]=0;continue}let p=a[n]/i,h=a[n+1]/i,d=p*p+h*h;if(d>9){let u=3/Math.sqrt(d);a[n]=u*p*i,a[n+1]=u*h*i}}return n=>{let i=n<0?0:n>1?1:n,p=e-2;for(let y=0;y<e-1;y++)if(i<=t[y+1]){p=y;break}let h=t[p],u=t[p+1]-h;if(u<=1e-9)return r[p];let c=(i-h)/u,l=c*c,m=l*c,f=2*m-3*l+1,b=m-2*l+c,v=-2*m+3*l,g=m-l;return f*r[p]+b*u*a[p]+v*r[p+1]+g*u*a[p+1]}}var ge=new Map;function Oe(o,e){let t=ge.get(o.name);return t||(t=Ue(o.profile),ge.set(o.name,t)),t(e)}function U(o,e){return o.height*Oe(o,e)}function We(o,e,t,r){let s=o.segments,a=o.height,n=o.height*1.45,i=Math.max(3,o.bellRings??5),p=Math.max(3,o.tentacles??8),h=(u,c,l,m,f,b,v,g,y=ye)=>{let x=e.length/T;return e.push(u,c,l,m,f,b,v,g,y),x},d=u=>{let c=u/i*(Math.PI/2);return{r:n*Math.sin(c),y:a*(1-Math.cos(c))}};{let u=Math.max(4,Math.floor(s*.8)),c=n*.055;for(let l=0;l<p;l++){let m=p===1?0:l/(p-1)*2-1,f=e.length/T;for(let b=0;b<=u;b++){let v=b/u,g=1+v*(s-1),y=m*n*(1-v*.22),x=c*(1-v*.55),w=Ge+l;h(g,y+x,0,v,1,0,.45,.6,w),h(g,y-x,0,v,-1,0,.45,.6,w)}for(let b=0;b<u;b++){let v=f+b*2,g=v+2;t.push(v,g,v+1,v+1,g,g+1)}}}{let u=e.length/T;for(let c=0;c<=i;c++){let{r:l,y:m}=d(c),f=c/i,b=.5+.5*f;h(0,l,m,f,1,0,.3,b,P),h(0,-l,m,f,-1,0,.3,b,P)}for(let c=0;c<i;c++){let l=u+c*2,m=l+2;t.push(l,m,l+1,l+1,m,m+1)}}{let u=Math.max(5,Math.round(p*.8)),c=n*.1,l=d(i);for(let m=0;m<u;m++){let f=(u===1?0:m/(u-1)*2-1)*n*.92,b=e.length/T,g=.5+Math.sin(Math.PI*(m+.5)/u)*.5;h(0,f,l.y-c,1,0,1,g,0,P),h(0,f+c,l.y,1,0,1,g,0,P),h(0,f,l.y+c,1,0,1,g,0,P),h(0,f-c,l.y,1,0,1,g,0,P),t.push(b,b+1,b+2,b,b+2,b+3)}}{let u=e.length/T;for(let c of X)for(let l=0;l<=i;l++){let{r:m,y:f}=d(l),b=l/i;h(0,m*c,f*c,b,1,0,0,c,P),h(0,-m*c,f*c,b,-1,0,0,c,P)}for(let c=0;c<X.length-1;c++)for(let l=0;l<i;l++){let m=u+(c*(i+1)+l)*2,f=m+2,b=m+(i+1)*2,v=b+2;r.push(m,b,m+1,m+1,b,b+1),r.push(m+1,b+1,f,f,b+1,v+1)}}}function Se(o){if(o.kind==="jelly"){let d=[],u=[],c=[];We(o,d,u,c);let l=d.length/T,m=u.length,f=m+c.length;return(l>k||f>C)&&console.error(`[\u6DF1\u6D77] \u4F53\u578B ${o.name} \u8D85\u51FA\u7F51\u683C\u5BB9\u91CF\uFF1A${l}/${k} \u9876\u70B9\uFF0C${f}/${C} \u7D22\u5F15`),{vertices:new Float32Array(d),indices:new Uint16Array([...u,...c]),vertexCount:Math.min(l,k),bodyIndexCount:Math.min(m,C),haloIndexCount:Math.min(c.length,C)}}let e=[],t=[],r=[],s=o.segments,a=o.height,n=(d,u,c,l,m,f,b,v,g=ye)=>{let y=e.length/T;return e.push(d,u,c,l,m,f,b,v,g),y};{let d=a*o.tailSpan,u=a*1.15,c=u*(1-o.tailFork*.72),l=[0,-a*.3],m=[d*.62,u],f=[0,c],b=[-d*.62,u],v=[l],g=(x,w,_,S)=>{for(let I=1;I<=S;I++){let A=I/S,M=1-A;v.push([M*M*x[0]+2*M*A*w[0]+A*A*_[0],M*M*x[1]+2*M*A*w[1]+A*A*_[1]])}};g(l,[d*.36,u*.28],m,4),g(m,[d*.2,u*.74],f,4),g(f,[-d*.2,u*.74],b,4),g(b,[-d*.36,u*.28],l,4);let y=e.length/T;n(s,0,l[1],1,0,0,.1,0);for(let[x,w]of v){let _=Math.abs(w-l[1])<1e-4?0:x>=0?1:-1,S=.18+.5*Math.min(1,Math.abs(w-l[1])/Math.max(1e-6,u));n(s,x,w,1,_,0,S,.85)}for(let x=1;x<v.length;x++)t.push(y,y+x,y+x+1)}{let d=o.dorsalStart,u=Math.min(d+.5,.94),c=7,l=e.length/T;for(let m=0;m<=c;m++){let f=m/c,b=d+(u-d)*f,v=U(o,b),g=Math.sin(Math.PI*f),y=b*s;n(y,v*.55,0,b,1,0,.05,.6),n(y,v+a*o.dorsal*g,0,b,1.4,0,.42,1)}for(let m=0;m<c;m++){let f=l+m*2,b=f+2;t.push(f,b,f+1,f+1,b,b+1)}}{let u=U(o,.3),c=a*o.pectoral;for(let l of[1,-1]){let m=e.length/T,f=.3*s;n(f,l*u*.5,0,.3,l,0,.05,.5),n(f+.9,l*(u*.5+c),c*1.1,.3+.1,l,0,.36,1),n(f+.5,l*(u*.25+c*.6),c*1.7,.3+.05,l,0,.36,1),t.push(m,m+1,m+2)}}{let d=e.length/T;for(let c=0;c<=s;c++){let l=c/s,m=U(o,l);for(let f of ve)n(c,m*f,0,l,f,0,0,Math.abs(f))}let u=ve.length;for(let c=0;c<s;c++)for(let l=0;l<u-1;l++){let m=d+c*u+l,f=m+u;t.push(m,f,m+1,m+1,f,f+1)}}if(o.photophores>0){let d=o.photophores,u=a*.11;for(let c=0;c<d;c++){let l=.14+c/Math.max(1,d-1)*.7,m=U(o,l),f=l*s,b=-m*.82,v=e.length/T,y=.55+Math.sin(Math.PI*(c+.5)/d)*.45;n(f,b,0,l,-1,1,y,0),n(f,b+u,0,l,-1,1,y,1),n(f+.11,b,u*.8,l,-1,1,y,1),n(f,b-u,0,l,-1,1,y,1),n(f-.11,b,u*.8,l,-1,1,y,1),t.push(v,v+1,v+2,v,v+2,v+3,v,v+3,v+4,v,v+4,v+1)}}let i=t.length;{let d=X.length,u=e.length/T;for(let c=0;c<d;c++){let l=X[c];for(let m=0;m<=s;m++){let f=m/s,b=U(o,f),v=.55+.45*Math.sin(Math.PI*Math.min(1,Math.max(0,f)));n(m,b*l*v,0,f,1,0,0,l*v),n(m,-b*l*v,0,f,-1,0,0,l*v)}}for(let c=0;c<d-1;c++)for(let l=0;l<s;l++){let m=u+(c*(s+1)+l)*2,f=m+2,b=m+(s+1)*2,v=b+2;r.push(m,b,m+1,m+1,b,b+1),r.push(m+1,b+1,f,f,b+1,v+1)}}let p=e.length/T,h=t.length+r.length;return(p>k||h>C)&&console.error(`[\u8BA1\u7B97\u6C34\u65CF\u7BB1] \u4F53\u578B ${o.name} \u8D85\u51FA\u7F51\u683C\u5BB9\u91CF\uFF1A${p}/${k} \u9876\u70B9\uFF0C${h}/${C} \u7D22\u5F15`),{vertices:new Float32Array(e),indices:new Uint16Array([...t,...r]),vertexCount:Math.min(p,k),bodyIndexCount:Math.min(i,C),haloIndexCount:Math.min(r.length,C)}}var Te=`#version 300 es
precision highp float;

in float aSpine;
in vec2  aLocal;
in vec2  aBody;
in vec2  aFlags;
in float aEdge;
in float aKind;

out vec2  vBody;
out vec2  vFlags;
out float vEdge;
out float vKind;

uniform vec4  uTankRect;
uniform vec2  uSpine[${$}];
uniform float uSpineCount;
uniform float uTime;

/** \u6574\u4F53\u5C3A\u5BF8\u500D\u7387\uFF08\u914D\u7F6E\u91CC\u7684 creatureScale\uFF09 */
uniform float uSize;
/** \u6C34\u6BCD\u4F1E\u4F53\u7684\u640F\u52A8 0..1 */
uniform float uPulse;
/** \u89E6\u624B\u6446\u52A8\u7684\u5E45\u5EA6\uFF08\u7F38\u5185 uv\uFF09 */
uniform float uSway;

vec2 spineAt(float t) {
  float last = max(1.0, uSpineCount - 1.0);
  float i = clamp(floor(t), 0.0, last - 1.0);
  float f = clamp(t - i, 0.0, 1.0);
  return mix(uSpine[int(i)], uSpine[int(i + 1.0)], f);
}

void main() {
  vec2 p = spineAt(aSpine);

  // \u5207\u5411\u7528\u6709\u9650\u5DEE\u5206
  float e = 0.4;
  vec2 tg = spineAt(aSpine + e) - spineAt(max(0.0, aSpine - e));
  float tl = length(tg);
  tg = tl > 1e-7 ? tg / tl : vec2(1.0, 0.0);

  // \u6CD5\u5411**\u5F3A\u5236\u671D\u4E0A**\uFF08\u7F38\u5185 uv \u7684 y \u5411\u4E0B\uFF0C\u6240\u4EE5\u671D\u4E0A = \u8D1F y\uFF09\u3002
  // \u4E0D\u5F3A\u5236\u7684\u8BDD\uFF0C\u751F\u7269\u4E00\u8F6C\u8EAB\u6CD5\u5411\u5C31\u7FFB\uFF0C\u80CC\u8DD1\u5230\u809A\u5B50\u4E0B\u9762\u53BB\u3002
  vec2 n = vec2(-tg.y, tg.x);
  if (n.y > 0.0) n = -n;

  vec2 local = aLocal * uSize;

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 \u6309\u90E8\u4EF6\u7C7B\u578B\u505A\u5404\u81EA\u7684\u5F62\u53D8 \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  if (aKind > 0.5 && aKind < 1.5) {
    // \u949F\u4F53\u640F\u52A8\uFF1A\u6A2A\u5411\u6536\u3001\u7EB5\u5411\u7565\u4F38 \u2014\u2014 \u771F\u5B9E\u6C34\u6BCD\u662F\u6536\u7F29\u4F1E\u4F53\u6392\u6C34\u524D\u8FDB\u7684\u3002
    // \u6536\u653E\u6BD4\u4F8B\u4E0D\u5BF9\u79F0\u662F\u6709\u610F\u7684\uFF1A\u6536\u5F97\u72E0\u3001\u653E\u5F97\u7F13\uFF0C\u770B\u8D77\u6765\u624D\u50CF\u5728\u6E38\u3002
    local.x *= 1.0 - uPulse * 0.18;
    local.y *= 1.0 + uPulse * 0.07;
  } else if (aKind >= 1.5) {
    // \u89E6\u624B\uFF1A\u8D8A\u9760\u672B\u7AEF\u6446\u5F97\u8D8A\u5927\uFF0C\u6BCF\u6761\u76F8\u4F4D\u4E0D\u540C\u3002
    // \u6574\u675F\u4E00\u8D77\u6446\u4F1A\u50CF\u4E00\u5757\u5E03\uFF0C\u5404\u81EA\u9519\u5F00\u624D\u50CF\u89E6\u624B\u3002
    float t = aSpine / max(1.0, uSpineCount - 1.0);
    float ph = aKind - 2.0;
    local.x += sin(uTime * 1.15 + ph * 1.9 + t * 1.7) * uSway * t * t;
  }

  vec2 world = p + n * local.x + tg * local.y;

  vec2 uv = uTankRect.xy + world * uTankRect.zw;
  gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);

  vBody = aBody;
  vFlags = aFlags;
  vEdge = aEdge;
  vKind = aKind;
}
`,we=`#version 300 es
precision highp float;

in vec2  vBody;
in vec2  vFlags;
in float vEdge;
in float vKind;
out vec4 fragColor;

/** 0 = \u8EAB\u4F53\uFF0C1 = \u5149\u6655 */
uniform float uPass;

uniform vec3  uGlow;
/** \u9C7C\u8EAB\u7684\u5E95\u8272\u3002**\u5FC5\u987B\u975E\u5E38\u6697** \u2014\u2014 \u8FB9\u7F18\u5149\u7684\u5BF9\u6BD4\u5EA6\u5168\u9760\u5B83\u3002 */
uniform vec3  uBodyDark;
/** \u4ECE\u4E0A\u65B9\u6765\u7684\u6C34\u5149\u989C\u8272\u3002\u7528\u4E8E\u80CC\u810A\u9AD8\u5149\uFF0C\u548C\u81EA\u53D1\u5149\u533A\u5206\u5F00\u3002 */
uniform vec3  uLight;
uniform float uGlowStrength;
uniform float uHaloStrength;
uniform float uOpacity;
uniform float uTime;

/**
 * \u89E3\u6790\u8986\u76D6\u7387\u3002
 *
 * vEdge \u662F\u5F52\u4E00\u5316\u534A\u5F84\uFF1A0 \u5728\u4F53\u8F74\uFF0C1 \u5728\u8F6E\u5ED3\u4E0A\u3002\u8F6E\u5ED3\u4E4B\u5916\u6CA1\u6709\u51E0\u4F55\uFF0C
 * \u6240\u4EE5\u53EA\u9760\u5B83\u505A\u4E0D\u5230\u300C\u8FB9\u7F18\u5916\u4FA7\u300D\u7684\u8986\u76D6 \u2014\u2014 \u4F46\u53EF\u4EE5\u505A\u5230**\u8FB9\u7F18\u5185\u4FA7\u4E00\u50CF\u7D20\u5185\u7684\u6E10\u53D8**\uFF0C
 * \u800C\u90A3\u4E00\u50CF\u7D20\u6B63\u662F\u952F\u9F7F\u7684\u6765\u6E90\u3002
 *
 * \u505A\u6CD5\uFF1A\u628A\u300C\u79BB\u8F6E\u5ED3\u8FD8\u6709\u591A\u8FDC\u300D\u6362\u7B97\u6210\u50CF\u7D20\u6570\uFF08\u7528 fwidth\uFF09\uFF0C
 * \u534A\u50CF\u7D20\u4EE5\u5185\u7ED9\u534A\u900F\u660E\u3001\u4E00\u50CF\u7D20\u4EE5\u5916\u7ED9\u5168\u4E0D\u900F\u660E\u3002
 *
 * \u8FD9\u4E00\u6761\u662F**\u53BB\u6389\u5EC9\u4EF7\u611F\u6700\u6709\u6548\u7684\u4E00\u7B14**\u3002\u6CA1\u6709\u5B83\uFF0C\u6240\u6709\u8F6E\u5ED3\u90FD\u662F\u786C\u952F\u9F7F\uFF0C
 * \u800C\u952F\u9F7F\u662F\u6700\u5178\u578B\u7684\u300C\u7A0B\u5E8F\u5458\u7F8E\u672F\u300D\u7279\u5F81\u3002
 *
 * \uFF08\u53E6\u5916\uFF1AGLSL \u5199\u5728 JS \u6A21\u677F\u5B57\u9762\u91CF\u91CC\uFF0C**\u6CE8\u91CA\u4E2D\u4E0D\u80FD\u51FA\u73B0\u53CD\u5F15\u53F7** \u2014\u2014
 *   \u5B83\u4F1A\u76F4\u63A5\u622A\u65AD\u6A21\u677F\u3002\u8FD9\u4E2A\u5751\u8E29\u5230\u7B2C\u56DB\u6B21\u4E86\u3002\uFF09
 */
float edgeCoverage(float edge) {
  // 1.6 \u662F\u8FC7\u6E21\u5BBD\u5EA6\uFF08\u50CF\u7D20\uFF09\u30021.0 \u592A\u7A84 \u2014\u2014 \u53EA\u8F6F\u5316\u4E86\u6700\u5916\u90A3\u4E00\u5217\u50CF\u7D20\uFF0C
  // \u5728\u653E\u5927\u6216\u9AD8\u5BF9\u6BD4\u7684\u8FB9\u7F18\u4E0A\u4ECD\u7136\u770B\u5F97\u51FA\u53F0\u9636\u3002
  const float AA_WIDTH = 1.6;
  float w = fwidth(edge);
  return clamp((1.0 - edge) / max(w * AA_WIDTH, 1e-5) + 0.5, 0.0, 1.0);
}

void main() {
  bool isGlow = vFlags.x > 0.5;

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 \u5149\u6655 pass \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  if (uPass > 0.5) {
    // \u653E\u5927\u4E4B\u540E\u539F\u672C\u7684\u4F53\u8868\u4F4D\u7F6E\u4E22\u4E86\uFF0C\u9760 aEdge \u53CD\u63A8\u771F\u5B9E\u534A\u5F84\uFF1A
    //   r = 1  \u5728\u4F53\u8868\u4E0A\uFF0Cr > 1 \u5728\u4F53\u8868\u4E4B\u5916
    float r = vEdge;
    // \u522B\u628A\u8FD9\u4E2A\u53D8\u91CF\u53EB out \u2014\u2014 \u5B83\u662F GLSL ES 3.00 \u7684\u4FDD\u7559\u5B57
    float beyond = max(0.0, r - 1.0);
    float falloff = exp(-beyond * 2.0) * exp(-beyond * beyond * 1.1);
    // \u6C34\u6BCD\u7684\u5149\u6655\u8981\u66F4\u67D4\u66F4\u6563\uFF1A\u5B83\u4EEC\u662F\u534A\u900F\u660E\u7684\uFF0C\u5149\u672C\u6765\u5C31\u4F1A\u6EA2\u51FA\u6765
    if (vKind > 0.5) falloff = exp(-beyond * 1.25) * exp(-beyond * beyond * 0.5);
    float a = falloff * uHaloStrength;
    fragColor = vec4(uGlow * a, a * uOpacity);
    return;
  }

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 \u53D1\u5149\u5668 \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  if (isGlow) {
    float amt = vFlags.y;
    // vEdge \u5728\u8FD9\u91CC\u662F\u300C\u79BB\u5149\u70B9\u4E2D\u5FC3\u591A\u8FDC\u300D\uFF1A0 = \u4E2D\u5FC3\uFF0C1 = \u8FB9\u7F18\u3002
    // \u7528\u5E73\u65B9\u8870\u51CF\u505A\u51FA\u67D4\u548C\u7684\u5149\u6591\uFF0C\u800C\u4E0D\u662F\u4E00\u4E2A\u786C\u83F1\u5F62 \u2014\u2014
    // \u53D1\u5149\u4F53\u6CA1\u6709\u786C\u8FB9\u754C\uFF0C\u8FD9\u662F\u5B83\u770B\u8D77\u6765\u5728\u53D1\u5149\u7684\u5FC5\u8981\u6761\u4EF6\u4E4B\u4E00\u3002
    float d = clamp(vEdge, 0.0, 1.0);
    float core = 1.0 - d * d;
    float soft = core * core;
    // \u518D\u53E0\u4E00\u5C42\u6781\u5C0F\u7684\u5916\u56F4\u5149\u6655\uFF0C\u8BA9\u4EAE\u70B9\u4E0D\u81F3\u4E8E\u50CF\u8D34\u4E0A\u53BB\u7684\u65B9\u5757
    soft += smoothstep(1.0, 0.35, d) * 0.22;
    vec3 c = uGlow * (2.6 * amt * soft * uGlowStrength);
    c = mix(c, vec3(1.0), clamp((amt - 0.5) * 0.55 * soft, 0.0, 0.7));
    // \u8FB9\u7F18\u6DE1\u51FA\uFF1A\u8FD9\u91CC\u4E5F\u9700\u8981\u6297\u952F\u9F7F\uFF0C\u5426\u5219\u5149\u70B9\u4F1A\u6709\u4E00\u5708\u786C\u8FB9
    float aa = edgeCoverage(clamp(d, 0.0, 1.0));
    fragColor = vec4(c, clamp(soft, 0.0, 1.0) * uOpacity * mix(1.0, aa, 0.5));
    return;
  }

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 \u6C34\u6BCD\uFF1A\u949F\u4F53 \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  if (vKind > 0.5 && vKind < 1.5) {
    float rim = smoothstep(0.45, 1.0, vEdge);
    // \u4F1E\u7F18\u6700\u4EAE\uFF08\u771F\u5B9E\u7684\u53D1\u5149\u6C34\u6BCD\u53D1\u5149\u5668\u5C31\u957F\u5728\u4F1E\u7F18\uFF09\uFF0C\u4F1E\u9876\u6700\u8584\u6700\u900F
    vec3 c = uGlow * (0.18 + rim * 1.15) * uGlowStrength;
    c = mix(c, vec3(1.0), rim * 0.22);
    // \u534A\u900F\u660E \u2014\u2014 \u6C34\u6BCD\u662F\u300C\u770B\u5F97\u7A7F\u300D\u7684\uFF0C\u8FD9\u4E00\u70B9\u662F\u5B83\u50CF\u6C34\u6BCD\u7684\u5173\u952E
    float alpha = mix(0.20, 0.62, rim);
    // \u6297\u952F\u9F7F\uFF1A\u4F1E\u7F18\u662F\u8FD9\u4E00\u5C42\u91CC\u5BF9\u6BD4\u5EA6\u6700\u9AD8\u7684\u8FB9\u754C\uFF0C\u4E0D\u5904\u7406\u4F1A\u975E\u5E38\u660E\u663E
    alpha *= edgeCoverage(clamp(vEdge, 0.0, 1.0));
    fragColor = vec4(c, alpha * uOpacity);
    return;
  }

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 \u6C34\u6BCD\uFF1A\u89E6\u624B \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  if (vKind >= 1.5) {
    // vBody.y \u5728\u89E6\u624B\u4E0A\u662F\u300C\u6A2A\u5411\u4F4D\u7F6E\u300D\uFF1A-1 \u5DE6\u7F18 / 0 \u4E2D\u7EBF / +1 \u53F3\u7F18\u3002
    // \u7528\u5B83\u505A\u4E00\u7EF4\u6297\u952F\u9F7F \u2014\u2014 \u7EC6\u5E26\u5B50\u7684\u952F\u9F7F\u6BD4\u8EAB\u4F53\u66F4\u624E\u773C\u3002
    float across = abs(clamp(vBody.y, -1.0, 1.0));
    float w = fwidth(vBody.y);
    float aa = clamp((1.0 - across) / max(w, 1e-5) + 0.5, 0.0, 1.0);
    vec3 c = uGlow * 0.55 * uGlowStrength;
    fragColor = vec4(c, 0.42 * uOpacity * aa);
    return;
  }

  // \u2014\u2014\u2014\u2014\u2014\u2014\u2014 \u9C7C \u2014\u2014\u2014\u2014\u2014\u2014\u2014
  float u = vBody.x;
  float v = clamp(vBody.y, -1.0, 1.0);

  // \u9CCD\uFF1A\u6309\u5EFA\u6A21\u65F6\u70D8\u8FDB\u6765\u7684\u91CF\u5404\u81EA\u53D1\u5149\u3002\u6CA1\u6709\u8FD9\u4E00\u9879\u9CCD\u662F\u5168\u9ED1\u7684\u3002
  float fin = vFlags.y;
  if (fin > 0.02 && abs(vBody.y) > 1.05) {
    vec3 fc = uGlow * fin * uGlowStrength * 0.62;
    fc *= 0.55 + 0.5 * smoothstep(0.35, 1.0, vEdge);
    // \u9CCD\u6839\u8981**\u6DE1\u51FA\u5230 0**\uFF0C\u4E0D\u80FD\u4E00\u4E0A\u6765\u5C31\u662F 0.3 \u7684\u4E0D\u900F\u660E\u5EA6 \u2014\u2014
    // \u90A3\u4F1A\u5728\u9CCD\u548C\u8EAB\u4F53\u7684\u4EA4\u754C\u5904\u7559\u4E0B\u4E00\u6761\u770B\u5F97\u89C1\u7684\u786C\u8FB9\uFF0C
    // \u653E\u5927\u770B\u5C31\u662F\u300C\u51E0\u5757\u591A\u8FB9\u5F62\u8D34\u5728\u4E00\u8D77\u300D\u7684\u611F\u89C9\u3002
    float root = smoothstep(0.02, 0.30, fin);
    // \u9CCD\u5C16\u4E5F\u6536\u4E00\u70B9\uFF0C\u514D\u5F97\u50CF\u88AB\u526A\u65AD
    float tip = 1.0 - smoothstep(0.75, 1.0, vEdge) * 0.0;
    float a = mix(0.30, 0.58, fin) * root * tip * edgeCoverage(clamp(vEdge, 0.0, 1.0));
    fragColor = vec4(fc, a * uOpacity);
    return;
  }

  // \u8179\u9762\u53D1\u5149\uFF1A**\u8D34\u7740\u4E0B\u7F18\u7684\u4E00\u6761\u7A84\u5E26**\uFF0C\u4E0D\u80FD\u662F\u6574\u4E2A\u4E0B\u534A\u8EAB \u2014\u2014
  // \u7528 v \u76F4\u63A5\u505A\u6E10\u53D8\u4F1A\u628A\u534A\u4E2A\u8EAB\u4F53\u70B9\u4EAE\uFF0C\u751F\u7269\u5C31\u4ECE\u300C\u6697\u526A\u5F71 + \u4EAE\u70B9\u300D
  // \u53D8\u6210\u4E00\u5757\u53D1\u5149\u7684\u8272\u6591\u3002
  //
  // \u6CE8\u610F smoothstep(e0, e1, x) \u8981\u6C42 e0 < e1\uFF0C\u53CD\u7740\u5199\u662F\u672A\u5B9A\u4E49\u884C\u4E3A\u3002
  float belly = smoothstep(0.72, 1.0, -v) * 0.50;
  // \u5934\u90E8\u6BD4\u5C3E\u90E8\u4EAE\u4E00\u70B9 \u2014\u2014 \u611F\u89C9\u5668\u5B98\u4E0E\u53D1\u5149\u5668\u96C6\u4E2D\u5728\u5934\u90E8
  float front = smoothstep(0.30, 0.0, u) * 0.16;

  // \u8EAB\u4F53\u7684\u57FA\u7840\u660E\u6697\uFF1A**\u80CC\u4EAE\u8179\u6697**\uFF0C\u4E2D\u95F4\u8FDE\u7EED\u8FC7\u6E21\u3002
  //
  // \u5C11\u4E86\u8FD9\u4E00\u5C42\uFF0C\u8EAB\u4F53\u5185\u90E8\u662F\u4E00\u5757\u5747\u5300\u7684\u9ED1\uFF0C\u4E8E\u662F\u80CC\u810A\u9AD8\u5149\u770B\u8D77\u6765\u5C31\u662F
  // \u300C\u4E00\u6761\u8D34\u5728\u9ED1\u5757\u4E0A\u7684\u4EAE\u5E26\u5B50\u300D\u800C\u4E0D\u662F\u300C\u5706\u67F1\u53D7\u5149\u300D\u2014\u2014 \u5EC9\u4EF7\u611F\u7684\u4E00\u5927\u6765\u6E90\u3002
  // \u6709\u4E86\u5B83\uFF0C\u526A\u5F71\u5185\u90E8\u624D\u6709\u4F53\u79EF\u3002
  float shade = 0.42 + 0.58 * smoothstep(-1.0, 1.0, v);
  vec3 col = uBodyDark * (0.45 + 1.15 * shade);

  col += uGlow * (belly + front) * uGlowStrength * 0.32;

  // \u81EA\u53D1\u5149 + \u88AB\u7167\u4EAE\uFF0C\u5206\u5F00\u7B97\uFF1A
  // \u8F6E\u5ED3\u4E0A\u7684\u7A84\u4EAE\u8FB9\uFF08\u81EA\u53D1\u5149\uFF09
  col += uGlow * smoothstep(0.80, 1.0, vEdge) * uGlowStrength * 0.40;
  // \u80CC\u810A\u9AD8\u5149\uFF08\u4ECE\u4E0A\u65B9\u6765\u7684\u6C34\u5149\uFF09\u2014\u2014 \u8FD9\u4E00\u7B14\u7ED9\u51FA\u5F62\u4F53\u7684\u8F6C\u6298
  // \u80CC\u810A\u9AD8\u5149\uFF08\u4ECE\u4E0A\u65B9\u6765\u7684\u6C34\u5149\uFF09\u2014\u2014 \u8FD9\u4E00\u7B14\u7ED9\u51FA\u5F62\u4F53\u7684\u8F6C\u6298\u3002
  //
  // \u26A0\uFE0F \u8FC7\u6E21\u533A\u95F4\u8981**\u591F\u5BBD**\u3002\u7B2C\u4E00\u7248\u7528\u7684\u662F smoothstep(0.05, 0.85, v)\uFF0C
  // \u5728\u653E\u5927\u770B\u65F6\u662F\u4E00\u6761\u8FB9\u754C\u6E05\u6670\u7684\u8272\u5E26 \u2014\u2014 \u90A3\u662F\u300C\u8D34\u7EB8\u300D\u800C\u4E0D\u662F\u300C\u5F62\u4F53\u300D\u3002
  // \u771F\u5B9E\u7684\u5149\u7167\u5728\u5706\u67F1\u5F62\u7684\u8EAB\u4F53\u4E0A\u662F\u4F59\u5F26\u5F0F\u7684\u8FDE\u7EED\u8FC7\u6E21\u3002
  float back = smoothstep(-0.25, 1.0, v);
  col += uLight * back * back * 0.95 * uGlowStrength;
  // \u8179\u9762\u4E5F\u6709\u4E00\u70B9\u5FAE\u5F31\u7684\u73AF\u5883\u53CD\u5C04\uFF0C\u8BA9\u526A\u5F71\u4E0D\u81F3\u4E8E\u4E0B\u534A\u622A\u7EAF\u9ED1
  col += uLight * smoothstep(-0.35, -0.95, v) * 0.16 * uGlowStrength;

  // \u8F6E\u5ED3\u6297\u952F\u9F7F \u2014\u2014 \u89C1 edgeCoverage \u7684\u8BF4\u660E
  float cov = edgeCoverage(clamp(vEdge, 0.0, 1.0));
  fragColor = vec4(col, cov * uOpacity);
}
`;var j={minX:.06,maxX:.94,minY:.14,maxY:.86};function L(o,e){let t=o*2654435761+e*2246822507>>>0;return t^=t>>>15,t=Math.imul(t,625341585)>>>0,t^=t>>>13,t=Math.imul(t,668265263)>>>0,t^=t>>>16,(t>>>0)/4294967296}function E(o,e,t,r){return t+L(o,e)*(r-t)}var ie=(()=>{let o=[],e=Object.keys(R);for(let t of e){let r=R[t].weight,s=Math.max(1,Math.round(r*6));for(let a=0;a<s;a++)o.push(t)}return o})();function He(o){let e=Math.floor(L(o,991)*ie.length)%ie.length;return ie[e]}function ce(o){let{id:e}=o,t=He(e),r=o.pinned?1:0,s=E(e,1,j.minX,j.maxX),a=E(e,2,j.minY,j.maxY)*(1-r*.3)+r*.22,n=E(e,3,.055,.11),i=E(e,4,.021,.047),p=E(e,5,.038,.082),h=Ee[t]??"cruise",d=Ye(h,E(e,6,.05,.16))*(1-r*.45),u=1;return o.discarded?u=.22:!o.active&&L(e,77)<.35&&(u=.62),o.audible&&(u=1.55),{id:e,tabId:o.tabId,shape:t,homeX:s,homeY:a,w1:n,w2:i,w3:p,p1:E(e,11,0,Math.PI*2),p2:E(e,12,0,Math.PI*2),p3:E(e,13,0,Math.PI*2),wander:d,speed:E(e,14,.75,1.35),scale:E(e,15,.85,1.15)*(1+r*.45),alt:L(e,21)<.14,schooling:R[t].kind==="fish"&&Xe.has(t)?1:0,schoolId:Math.floor(L(e,907)*Re)%Re,gait:Ee[t]??"cruise",energy:u,fade:0,baseScale:E(e,15,.85,1.15),title:o.title,pinned:o.pinned,audible:o.audible,discarded:o.discarded,active:o.active}}function ze(o,e){o.title=e.title,o.pinned=e.pinned,o.audible=e.audible,o.discarded=e.discarded,o.active=e.active,o.scale=o.baseScale*(e.pinned?1.45:1);let t=1;e.discarded?t=.22:!e.active&&L(o.id,77)<.35&&(t=.62),e.audible&&(t=1.55),o.energy=t}var Ee={lantern:"cruise",angler:"dart",hatchet:"hover",ribbon:"drift",moonjelly:"drift",lighthouse:"drift"};function Ve(o,e){switch(o){case"drift":return e*.42;case"hover":return e*.55;case"dart":return e+Math.sin(e*.33)*.62;default:return e}}function Ye(o,e){return o==="hover"?e*.42:o==="drift"?e*1.35:o==="dart"?e*.75:e}var Xe=new Set(["lantern","hatchet","ribbon"]),Re=2;function Ae(o,e){let t=L(o,811),r=L(o,823),s=L(o,829),a=.16+t*.68,n=.26+r*.38,i=.055+s*.045,p=a+Math.sin(e*.043+t*6.28)*i*1.6+Math.sin(e*.017+r*6.28)*i,h=n+Math.sin(e*.029+s*6.28)*.075;return{x:p,y:h}}function Me(o,e,t){let r=Ve(o.gait,e*o.speed),s=.35;if(o.schooling>0){let c=Ae(o.schoolId,e),l=o.p1+r*(.42+o.w1*1.8),m=o.wander*.55;t.x=c.x+Math.cos(l)*m+Math.sin(r*o.w2*2.4+o.p2)*.01,t.y=c.y+Math.sin(l)*m*.52+Math.sin(r*o.w3*1.9+o.p3)*.009;let f=Ae(o.schoolId,e+s),b=f.x-c.x,v=f.y-c.y,g=Math.sin(r*.9+o.p2)*.22,y=Math.cos(g),x=Math.sin(g),w=b*y-v*x,_=b*x+v*y;b=w,v=_;let S=Math.sqrt(b*b+v*v);return S>1e-7?(t.dx=b/S,t.dy=v/S):(t.dx=1,t.dy=0),t}let a=c=>o.homeX+o.wander*(Math.sin(c*o.w1+o.p1)*.68+Math.sin(c*o.w2+o.p2)*.32),n=c=>o.homeY+o.wander*.62*Math.sin(c*o.w3+o.p3);t.x=a(r),t.y=n(r);let i=a(r+s),p=n(r+s),h=i-t.x,d=p-t.y,u=Math.sqrt(h*h+d*d);return u>1e-7?(h/=u,d/=u):(h=1,d=0),t.dx=h,t.dy=d,t}var $e=18,je=.9,Ke=1.6;function Ce(o){let e=0;return o.pinned&&(e+=1e3),o.audible&&(e+=500),o.active&&(e+=250),e+=Math.max(0,60-o.index),e}var K=class{items=[];byTab=new Map;max;constructor(e={}){this.max=Math.max(1,e.maxCreatures??$e)}get list(){return this.items}setMax(e){this.max=Math.max(1,Math.round(e))}get count(){return this.items.length}byTabId(e){return this.byTab.get(e)}sync(e,t){let r=[...e].sort((n,i)=>Ce(i)-Ce(n)),s=new Set;for(let n of r){if(s.size>=this.max)break;s.add(n.id)}for(let n of e){if(!s.has(n.id))continue;let i=this.byTab.get(n.id);i||(i=ce({id:n.id,tabId:n.id,title:n.title,pinned:n.pinned,audible:n.audible,discarded:n.discarded,active:n.active}),this.byTab.set(n.id,i),this.items.push(i)),ze(i,n)}let a=Math.max(0,Math.min(t,.25));for(let n=this.items.length-1;n>=0;n--){let i=this.items[n];s.has(i.tabId)?i.fade=Math.min(1,i.fade+a/je):(i.fade-=a/Ke,i.fade<=0&&(i.fade=0,this.byTab.delete(i.tabId),this.items.splice(n,1)))}}clear(){this.items.length=0,this.byTab.clear()}};var qe=.55,Qe=1.35,q=class{gl;program;meshes=new Map;spine=new Float32Array($*2);stats={creatures:0,draws:0};lastPoses=[];currentScale=1;constructor(e){this.gl=e,this.program=new H(e,Te,we,se.map(t=>t.name)),this.buildMeshes()}buildMeshes(){for(let e of Object.keys(R)){let t=R[e],r=Se(t),s=new z(this.gl,se,this.program,k,C);s.update(r.vertices,r.indices),this.meshes.set(e,{mesh:s,bodyIndexCount:r.bodyIndexCount,haloIndexCount:r.haloIndexCount})}}render(e){let t=this.gl,r=e.creatures;if(r.length===0)return;this.stats.creatures=r.length,this.stats.draws=0,this.currentScale=e.creatureScale;let s=this.lastPoses;s.length=0;for(let n of r){let i={x:0,y:0,dx:1,dy:0};Me(n,e.time,i),s.push(i)}t.enable(t.BLEND),t.blendFunc(t.ONE,t.ONE);let a=this.program.use();a.vec4("uTankRect",e.tankRect[0],e.tankRect[1],e.tankRect[2],e.tankRect[3]),a.float("uPass",1),a.float("uHaloScale",1),a.float("uTime",e.time),a.vec3("uBodyDark",0,0,0),a.float("uGlowStrength",1);for(let n=0;n<r.length;n++){let i=r[n],p=this.meshes.get(i.shape);if(!p)continue;let h=s[n],d=this.buildSpine(i,h,e.time);a.float("uSpineCount",d+1),a.vec2Array("uSpine",this.spine),this.setCreatureUniforms(a,i,e,!0),p.mesh.draw(p.haloIndexCount,p.bodyIndexCount),this.stats.draws++}t.blendFuncSeparate(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA,t.ONE,t.ONE_MINUS_SRC_ALPHA),a.float("uPass",0),a.float("uHaloScale",1);for(let n=0;n<r.length;n++){let i=r[n],p=this.meshes.get(i.shape);if(!p)continue;let h=s[n],d=this.buildSpine(i,h,e.time);a.float("uSpineCount",d+1),a.vec2Array("uSpine",this.spine),this.setCreatureUniforms(a,i,e,!1),p.mesh.draw(p.bodyIndexCount,0),this.stats.draws++}t.disable(t.BLEND)}setCreatureUniforms(e,t,r,s){let a=t.alt?r.palette.glowAlt:r.palette.glow,n=t.audible?1+Math.sin(r.time*1.5+t.p1)*.38:1,i=Math.min(1,Math.max(0,r.intro*1.35-t.id%7*.05)),p=t.energy*n*i*t.fade;if(e.vec3("uGlow",a[0],a[1],a[2]),e.vec3a("uLight",r.palette.light),e.float("uSize",r.creatureScale),e.float("uSway",.006*t.scale),R[t.shape].kind==="jelly"){let d=r.time*(.55+t.speed*.35)+t.p1,u=Math.sin(d),c=u>0?u*u*u:0;e.float("uPulse",c)}else e.float("uPulse",0);s?(e.float("uHaloStrength",.55*p*r.palette.bloom),e.float("uOpacity",r.opacity*Math.min(1,t.fade))):(e.float("uGlowStrength",p*(.85+r.palette.bloom*.25)),e.vec3("uBodyDark",r.palette.waterDeep[0]*9+.005,r.palette.waterDeep[1]*9+.011,r.palette.waterDeep[2]*9+.02),e.float("uOpacity",r.opacity*Math.min(1,t.fade)))}buildSpine(e,t,r){let s=R[e.shape],a=s.segments,n=s.length*e.scale*this.currentScale;if(s.kind==="jelly"){let c=r*(.55+e.speed*.35)+e.p1,m=-Math.max(0,Math.sin(c))*n*.1,f=Math.sin(r*.21+e.p2)*n*.06,b=t.x+f,v=t.y+m,g=0,y=-1,x=1,w=0,_=n*.035;for(let S=0;S<=a;S++){let I=a>0?S/a:0,A=n*(.44-I*.92),M=Math.sin(r*.9-I*2.2+e.p1)*_*I;this.spine[S*2]=b+g*A+x*M,this.spine[S*2+1]=v+y*A+w*M}return a}let i=n*(e.shape==="ribbon"?.16:.085),p=r*qe*e.speed*(e.shape==="ribbon"?.75:1.15),h=-t.dy,d=t.dx;d>0&&(h=-h,d=-d);let u=.25+.75*Math.min(1,e.energy);for(let c=0;c<=a;c++){let l=a>0?c/a:0,m=n*(.42-l*.92),f=Math.sin(p-l*Qe)*i*(.06+.94*l*l)*u;this.spine[c*2]=t.x+t.dx*m+h*f,this.spine[c*2+1]=t.y+t.dy*m+d*f}return a}get poses(){return this.lastPoses}pick(e,t,r){let s=this.lastPoses,a=null,n=1/0;for(let i=0;i<r.length&&i<s.length;i++){let p=s[i],h=r[i];if(h.fade<.35)continue;let d=p.x-e,u=p.y-t,c=d*d+u*u,l=Math.max(.055,h.scale*.06);c<l*l&&c<n&&(n=c,a=h)}return a}dispose(){for(let e of this.meshes.values())e.mesh.dispose();this.meshes.clear(),this.program.dispose()}};var Je={open:0,trench:1,snowfield:2,vent:3,ruins:4},Ze=.035,et=.2,tt=.35,Q=4;function ot(o,e,t,r){let s=Math.max(.1,e);if(o==="fill")return[(1-s)/2,(1-s)/2,s,s];let a=16/9,n,i;o==="letterbox"?r>a?(i=1,n=a/r):(n=1,i=r/a):r>a?(i=.82,n=a/r*.82):(n=.82,i=r/a*.82),n*=s,i*=s;let p=(1-n)/2,h=(1-i)/2;return t==="top"?h=0:t==="bottom"&&(h=1-i),[p,h,n,i]}var J=class{canvas;ctx;gl;vao;sceneRT;bloomA;bloomB;sceneProg;brightProg;blurProg;compositeProg;creatureRenderer;disposed=!1;lastRect=[0,0,1,1];constructor(e,t={}){this.canvas=e,this.ctx=me(e,{preferFloatTargets:!0,alpha:t.alpha??!1}),this.gl=this.ctx.gl;let r=this.gl;this.vao=fe(r),r.bindVertexArray(this.vao);let s=Math.max(1,e.width),a=Math.max(1,e.height);this.sceneRT=B(r,s,a,this.ctx.floatTargets);let n=Math.max(1,Math.floor(s/Q)),i=Math.max(1,Math.floor(a/Q));this.bloomA=B(r,n,i,this.ctx.floatTargets),this.bloomB=B(r,n,i,this.ctx.floatTargets),this.sceneProg=new F(r,he,G),this.brightProg=new F(r,de,G),this.blurProg=new F(r,be,G),this.compositeProg=new F(r,pe,G),this.creatureRenderer=new q(r)}get info(){return{renderer:this.ctx.renderer,software:this.ctx.software,floatTargets:this.ctx.floatTargets}}get drawStats(){return this.creatureRenderer.stats}pick(e,t,r){return this.creatureRenderer.pick(e,t,r)}get poses(){return this.creatureRenderer.poses}get tankRect(){return this.lastRect}render(e){if(this.disposed)return;let t=this.gl,r=this.canvas,s=Math.max(1,r.width),a=Math.max(1,r.height),n=s/a;this.ensureSize(s,a);let i=ot(e.framing,e.zoom,e.anchorY,n);this.lastRect=i;let p=0;e.layers.surface&&(p|=te),e.layers.caustics&&(p|=oe),e.layers.rays&&(p|=re),e.layers.snow&&(p|=ne),e.layers.vignette&&(p|=ae),D(t,this.sceneRT,s,a),t.disable(t.BLEND);let h=this.sceneProg.use();h.vec4("uTankRect",i[0],i[1],i[2],i[3]),h.vec2("uResolution",s,a),h.float("uAspect",n),h.float("uTime",e.time),h.float("uSeed",3.7),h.float("uIntro",e.intro),h.vec3a("uWaterTop",e.palette.waterTop),h.vec3a("uWaterDeep",e.palette.waterDeep),h.vec3a("uLight",e.palette.light),h.vec3a("uCaustic",e.palette.caustic),h.float("uAmbient",e.palette.ambient),h.float("uTurbidity",e.palette.turbidity),h.int("uDetail",e.quality.detail),h.int("uLayers",p),h.int("uBackdrop",Je[e.backdrop??"open"]??0),N(t),e.layers.creatures&&e.creatures.length>0&&(this.creatureRenderer.render({tankRect:i,creatures:e.creatures,palette:e.palette,time:e.time,intro:e.intro,opacity:1,creatureScale:e.creatureScale}),t.disable(t.BLEND));let d=this.bloomA.width,u=this.bloomA.height,c=this.bloomA.texture;if(e.layers.bloom&&e.bloom>.001){D(t,this.bloomA,d,u),t.disable(t.BLEND);let m=this.brightProg.use();m.texture("uScene",0,this.sceneRT.texture),m.float("uThreshold",et),m.float("uKnee",tt),N(t);let f=this.blurProg.use();D(t,this.bloomB,d,u),f.texture("uSource",0,this.bloomA.texture),f.vec2("uDir",1/d,0),N(t),D(t,this.bloomA,d,u),f.texture("uSource",0,this.bloomB.texture),f.vec2("uDir",0,1/u),N(t),c=this.bloomA.texture}D(t,null,s,a),t.disable(t.BLEND);let l=this.compositeProg.use();l.texture("uScene",0,this.sceneRT.texture),l.texture("uBloom",1,c),l.vec4("uTankRect",i[0],i[1],i[2],i[3]),l.float("uTime",e.time),l.float("uBloomStrength",e.layers.bloom?e.bloom*e.palette.bloom:0),l.float("uOpacity",e.opacity),l.float("uWaterLine",Ze),N(t),t.bindVertexArray(this.vao)}ensureSize(e,t){if(this.sceneRT.width===e&&this.sceneRT.height===t)return;let r=this.gl;this.sceneRT=V(r,this.sceneRT,e,t,this.ctx.floatTargets);let s=Math.max(1,Math.floor(e/Q)),a=Math.max(1,Math.floor(t/Q));this.bloomA=V(r,this.bloomA,s,a,this.ctx.floatTargets),this.bloomB=V(r,this.bloomB,s,a,this.ctx.floatTargets)}resizeToDisplay(e){let r=Math.min(typeof devicePixelRatio=="number"?devicePixelRatio:1,2),s=Math.max(.3,e)*r,a=Math.max(2,Math.floor(this.canvas.clientWidth*s)),n=Math.max(2,Math.floor(this.canvas.clientHeight*s));return(this.canvas.width!==a||this.canvas.height!==n)&&(this.canvas.width=a,this.canvas.height=n),{width:a,height:n}}dispose(){if(this.disposed)return;this.disposed=!0;let e=this.gl;this.sceneRT.dispose(),this.bloomA.dispose(),this.bloomB.dispose(),this.sceneProg.dispose(),this.brightProg.dispose(),this.blurProg.dispose(),this.compositeProg.dispose(),this.creatureRenderer.dispose(),e.deleteVertexArray(this.vao)}};function Le(){let o=["\u56FE\u8868 \xB7 \u5B63\u5EA6\u590D\u76D8","\u6587\u6863 \xB7 \u8BBE\u8BA1\u7A3F\u8BC4\u8BBA","\u90AE\u4EF6 \xB7 \u6536\u4EF6\u7BB1","\u4EE3\u7801 \xB7 \u62C9\u53D6\u8BF7\u6C42","\u89C6\u9891 \xB7 \u8BB2\u5EA7\u56DE\u653E","\u8D2D\u7269 \xB7 \u663E\u793A\u5668\u5BF9\u6BD4","\u65B0\u95FB \xB7 \u65E9\u62A5","\u97F3\u4E50 \xB7 \u4E13\u6CE8\u6B4C\u5355","\u65E5\u5386 \xB7 \u672C\u5468\u5B89\u6392","\u5730\u56FE \xB7 \u901A\u52E4\u8DEF\u7EBF","\u76F8\u518C \xB7 \u5468\u672B","\u7B14\u8BB0 \xB7 \u7075\u611F","\u7EC8\u7AEF \xB7 \u90E8\u7F72\u65E5\u5FD7","\u8BBA\u6587 \xB7 \u6CE8\u610F\u529B\u673A\u5236"],e=new Set,t=12;return{hasTitles:!0,list:async()=>{let s=[];for(let a=0;a<t;a++)s.push({id:1e3+a*137,title:o[a%o.length],pinned:a<2,audible:a===3,discarded:a===5||a===9,active:a===0,index:a,windowId:1});return s},subscribe(s){return e.add(s),()=>e.delete(s)},async activate(){},async close(){t=Math.max(1,t-1);for(let s of e)s()}}}var _e={abyss:{theme:"abyss",waterTop:[.02,.058,.082],waterDeep:[.002,.006,.012],light:[.34,.62,.72],caustic:[.3,.68,.78],glow:[.22,.86,.9],glowAlt:[.96,.62,.34],glassTint:[.06,.2,.2],accent:[.45,.88,.92],ambient:.34,turbidity:.3,bloom:1},vent:{theme:"vent",waterTop:[.04,.028,.026],waterDeep:[.007,.004,.004],light:[.7,.42,.24],caustic:[.82,.5,.24],glow:[1,.58,.24],glowAlt:[.42,.86,.72],glassTint:[.2,.12,.07],accent:[1,.66,.34],ambient:.3,turbidity:.46,bloom:1.15},aurora:{theme:"aurora",waterTop:[.016,.04,.062],waterDeep:[.002,.005,.014],light:[.3,.66,.58],caustic:[.36,.74,.64],glow:[.34,.94,.68],glowAlt:[.66,.52,.98],glassTint:[.08,.16,.2],accent:[.52,.94,.74],ambient:.32,turbidity:.26,bloom:1.1},moonlit:{theme:"moonlit",waterTop:[.052,.078,.104],waterDeep:[.008,.014,.024],light:[.62,.74,.86],caustic:[.56,.7,.84],glow:[.7,.88,1],glowAlt:[.94,.76,.56],glassTint:[.12,.16,.22],accent:[.76,.88,1],ambient:.46,turbidity:.34,bloom:.85}};function Pe(o){return _e[o]??_e.abyss}var ke={surface:!0,caustics:!0,rays:!0,snow:!0,vignette:!0,creatures:!0,bloom:!0},Ut={enabled:!0,opacity:1,framing:"fill",zoom:1,anchorY:"center",theme:"abyss",quality:"high",fpsCap:30,bloom:1,maxCreatures:18,creatureScale:.62,backdrop:"open",layers:{...ke},clickToSwitch:!0,hoverTitles:!0,demoMode:!1},Ie={enabled:!1,opacity:.5,framing:"center",zoom:.85,anchorY:"bottom",theme:"abyss",quality:"medium",fpsCap:24,bloom:0,maxCreatures:9,creatureScale:.42,backdrop:"open",layers:{...ke,rays:!1,vignette:!1,bloom:!1},clickToSwitch:!1,hoverTitles:!1,demoMode:!1};function Fe(o,e){return o==="auto"?e?{renderScale:.62,detail:0}:{renderScale:1,detail:2}:o==="low"?{renderScale:.62,detail:0}:o==="medium"?{renderScale:.85,detail:1}:{renderScale:1,detail:2}}var rt={surface:!0,caustics:!0,rays:!0,snow:!0,vignette:!0,creatures:!0,bloom:!0},Z=class{constructor(e,t={}){this.canvas=e;this.opts=t}canvas;opts;renderer=null;flock=new K({maxCreatures:18});tabs=[];forced=[];t=0;last=0;raf=0;running=!1;disposed=!1;async start(){if(!(this.disposed||this.running)){if(!this.renderer){try{this.renderer=new J(this.canvas,{alpha:!1})}catch(e){console.warn("[\u6DF1\u6D77] \u65E0\u6CD5\u521B\u5EFA\u6E32\u67D3\u5668",e),this.disposed=!0;return}if(this.opts.onRenderer?.(this.renderer.info.renderer),this.opts.onlyShape)this.forced=this.buildForced();else{let e=await Le().list();this.tabs=e.slice(0,this.opts.count??e.length)}}this.running=!0,this.last=performance.now(),this.raf=requestAnimationFrame(this.loop)}}stop(){this.running=!1,cancelAnimationFrame(this.raf)}dispose(){this.stop(),this.disposed=!0,this.renderer?.dispose(),this.renderer=null}buildForced(){let e=this.opts.onlyShape,t=[];for(let r=0;r<(this.opts.count??2);r++){let s=ce({id:8e3+r*977,tabId:-1,title:"",pinned:!1,audible:!1,discarded:!1,active:r===0});s.shape=e,s.schooling=0,s.homeX=.32+r*.36,s.homeY=.42+r%2*.14,s.fade=1,s.energy=1,t.push(s)}return t}loop=e=>{if(!this.running)return;this.raf=requestAnimationFrame(this.loop);let t=this.renderer;if(!t)return;let r=Math.min(.1,(e-this.last)/1e3);this.last=e,this.t+=r;let s=Fe("medium",t.info.software);t.resizeToDisplay(s.renderScale);let a=this.opts.boost??1,n=Pe(this.opts.theme??"abyss"),i=a===1?n:{...n,ambient:n.ambient*a,bloom:n.bloom*(1+(a-1)*.6),waterTop:[n.waterTop[0]*(1+(a-1)*.8),n.waterTop[1]*(1+(a-1)*.8),n.waterTop[2]*(1+(a-1)*.8)]},p;this.opts.onlyShape?p=this.forced:(this.flock.setMax(this.opts.maxCreatures??18),this.flock.sync(this.tabs,r),p=this.flock.list),mt(this),t.render({time:this.t,intro:Math.min(1,this.t/1.4),palette:i,layers:rt,quality:s,framing:this.opts.framing??"letterbox",zoom:this.opts.zoom??1,anchorY:"center",opacity:1,bloom:1,creatures:p,creatureScale:this.opts.creatureScale??.62,backdrop:this.opts.backdrop??"open"})}};function nt(o,e,t="220px"){new IntersectionObserver(s=>{for(let a of s)a.isIntersecting?o.start():o.stop()},{rootMargin:t}).observe(e)}function at(){let o=document.getElementById("foot-renderer");o&&(o.textContent="")}function le(o,e){let t=document.createElement("div");t.className="card";let r=document.createElement("div");r.className="card__title";let s=document.createElement("b");s.textContent=e.title;let a=document.createElement("span");a.textContent=e.note,r.append(s,a);let n=document.createElement("canvas");n.className="frame__canvas",n.style.aspectRatio=e.onlyShape?"4 / 3":"16 / 10",t.append(r,n),o.appendChild(t);let i=new Z(n,{theme:e.theme,backdrop:e.backdrop,onlyShape:e.onlyShape,count:e.count,creatureScale:e.creatureScale??1,boost:e.boost??1.45,framing:e.framing??"fill",zoom:e.onlyShape?1.35:1,maxCreatures:8,onRenderer:at});nt(i,t)}var st=[{theme:"abyss",title:"\u6DF1\u6E0A",note:"\u8FD1\u9ED1\u6C34\u4F53 \xB7 \u9752\u8272\u8F89\u5149"},{theme:"vent",title:"\u70ED\u6CC9",note:"\u9ED1\u6C34 \xB7 \u7425\u73C0\u8272"},{theme:"aurora",title:"\u6781\u5149",note:"\u9ED1\u6C34 \xB7 \u7EFF\u4E0E\u7D2B"},{theme:"moonlit",title:"\u6708\u591C",note:"\u94F6\u84DD \xB7 \u6700\u4EAE\u7684\u4E00\u6863"}],it=[{backdrop:"open",title:"\u5F00\u9614\u6C34\u57DF",note:"\u4EC0\u4E48\u90FD\u4E0D\u753B\uFF0C\u6700\u5B89\u9759"},{backdrop:"trench",title:"\u6D77\u6C9F",note:"\u8FDC\u5904\u4E00\u9053\u9ED1\u538B\u538B\u7684\u5D16\u58C1"},{backdrop:"snowfield",title:"\u6C89\u964D\u96EA\u539F",note:"\u5BC6\u96C6\u7684\u6709\u673A\u788E\u5C51\u7F13\u7F13\u843D\u4E0B"},{backdrop:"vent",title:"\u70ED\u6CC9\u55B7\u53E3",note:"\u51E0\u7F15\u4E0A\u5347\u7684\u9ED1\u70DF"},{backdrop:"ruins",title:"\u9057\u8FF9",note:"\u51E0\u6839\u503E\u9893\u7684\u67F1\u5B50"}],ct=[{shape:"lantern",title:"\u706F\u7B3C\u9C7C",note:"\u7EC6\u957F\u9C7C\u96F7\u5F62 \xB7 \u6210\u7FA4\u5DE1\u822A"},{shape:"hatchet",title:"\u65A7\u5934\u9C7C",note:"\u77ED\u800C\u9AD8 \xB7 \u60AC\u505C"},{shape:"angler",title:"\u9B9F\u9C47",note:"\u5706\u80D6 \xB7 \u5B88\u682A\u5F85\u5154"},{shape:"ribbon",title:"\u6DF1\u6D77\u5E26\u9C7C",note:"\u957F\u6761 \xB7 \u968F\u6C34\u6F02\u79FB"},{shape:"moonjelly",title:"\u6D77\u6708\u6C34\u6BCD",note:"\u6241\u4F1E \xB7 \u89E6\u624B\u7EC6\u800C\u591A"},{shape:"lighthouse",title:"\u706F\u5854\u6C34\u6BCD",note:"\u949F\u5F62\u4F1E \xB7 \u89E6\u624B\u5C11\u800C\u7C97"}];function lt(){let o=document.getElementById("themes");if(o)for(let r of st)le(o,{theme:r.theme,title:r.title,note:r.note,count:7,creatureScale:1.05});let e=document.getElementById("backdrops");if(e)for(let r of it)le(e,{theme:"abyss",backdrop:r.backdrop,title:r.title,note:r.note,count:6,creatureScale:1.05});let t=document.getElementById("species");if(t)for(let r of ct)le(t,{onlyShape:r.shape,title:r.title,note:r.note,count:2,creatureScale:.95})}async function ut(){let o=document.getElementById("hero-tank");if(!o)return;let e=new Z(o,{theme:"abyss",backdrop:"trench",framing:"fill",maxCreatures:20,creatureScale:.66,onRenderer:r=>{let s=document.getElementById("foot-renderer");s&&(s.textContent=r)}});await e.start(),new IntersectionObserver(r=>{for(let s of r)s.isIntersecting?e.start():e.stop()},{threshold:.05}).observe(o)}function mt(o){let e=window,t=e.__aqua??{},r=(t.frames??0)+1;e.__aqua={...t,frames:r,ready:r>=3,surface:"site"}}function ft(){document.readyState==="loading"?document.addEventListener("DOMContentLoaded",De,{once:!0}):De()}function De(){lt(),ut();let o=document.getElementById("repo-link");if(o){let e=document.querySelector('meta[name="repo-url"]')?.getAttribute("content");e&&(o.href=e)}}ft();
