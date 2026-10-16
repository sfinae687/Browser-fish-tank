/**
 * 鱼的渲染。
 *
 * 每个基因组建一份网格（一次），每条鱼每帧只上传**脊柱点**作为 uniform，
 * 身体怎么弯由顶点着色器算。所以 CPU 每帧的成本只与鱼的**条数**有关，
 * 与顶点数无关。
 *
 * 这也是全项目第一处真正的顶点管线。植物走的是「烘焙成纹理」，
 * 因为它们的形态生成一次就不变；鱼每帧都在变形，那条路对它们不成立。
 */

import { MeshProgram, DynamicMesh, type GL } from './gl.js';
import { FISH_VS, FISH_FS, FISH_VERTEX_LAYOUT, MAX_SPINE_POINTS } from './shaders/fish.js';
import {
  buildFishMesh,
  genomeColors,
  FISH_MAX_VERTICES,
  FISH_MAX_INDICES,
} from './fish-mesh.js';
import { unfx } from '../core/fixed.js';
import { wave01 } from '../core/wave.js';
import type { Genome } from '../core/genome.js';
import type { MotionSeed, SchoolPose } from '../core/school.js';
import type { Palette } from '../core/theme.js';

/** 摆尾频率（次/秒）的基准。提速时会更快，慢游时更慢。 */
const BEAT_RATE = 1.35;
/** 行波沿身体传播的相位差。整条身体大约落后一个波长的一半。 */
const WAVE_LAG = 0.95;

interface GenomeMesh {
  mesh: DynamicMesh;
  indexCount: number;
  colors: ReturnType<typeof genomeColors>;
}

/**
 * 渲染一条鱼所需要知道的生态量。
 * `world.ts` 的 `FishRecord` 在结构上满足它 —— 渲染层不需要知道
 * 能量是怎么算出来的，只需要知道它现在是多少。
 */
export interface RenderableFish extends MotionSeed {
  /** 能量（定点） */
  energy: number;
}

export interface FishFrameParams {
  tankRect: readonly [number, number, number, number];
  genomes: readonly Genome[];
  seeds: readonly RenderableFish[];
  pose: SchoolPose;
  palette: Palette;
  timeSeconds: number;
  daylight: number;
  /** 水面在缸内 uv 的 y */
  waterLine: number;
  /** 砂线位置，用于算每条鱼的水深衰减 */
  sandLine: number;
  turbidity: number;
  opacity: number;
}

export class FishRenderer {
  private readonly gl: GL;
  private readonly program: MeshProgram;
  private readonly meshes = new Map<number, GenomeMesh>();
  private readonly spine = new Float32Array(MAX_SPINE_POINTS * 2);
  /** 每个基因组编译一次网格的成本记录，用于诊断 */
  readonly stats = { meshes: 0, draws: 0, vertices: 0 };

  constructor(gl: GL) {
    this.gl = gl;
    this.program = new MeshProgram(
      gl,
      FISH_VS,
      FISH_FS,
      FISH_VERTEX_LAYOUT.map((a) => a.name),
    );
  }

  /**
   * 确保每个基因组都有对应的网格。
   *
   * 每帧调用也无所谓：已存在的直接跳过，而池子上限是 56，
   * 一次 Map 查找的量级完全可以忽略。这样繁殖产生新基因组时
   * 也**一定**会被建出来，不需要额外的失效通知机制。
   */
  sync(genomes: readonly Genome[]): void {
    for (const g of genomes) {
      if (this.meshes.has(g.id)) continue;
      const data = buildFishMesh(g);
      const mesh = new DynamicMesh(
        this.gl,
        FISH_VERTEX_LAYOUT,
        this.program,
        FISH_MAX_VERTICES,
        FISH_MAX_INDICES,
      );
      mesh.update(data.vertices, data.indices);
      this.meshes.set(g.id, {
        mesh,
        indexCount: data.indexCount,
        colors: genomeColors(g),
      });
      this.stats.meshes++;
      this.stats.vertices += data.vertexCount;
    }
  }

  /**
   * 画出这一帧的全部鱼。
   *
   * 调用方需要先把混合打开 —— 鱼有半透明的鳍。
   */
  render(p: FishFrameParams): void {
    const gl = this.gl;
    const n = p.pose.count;
    if (n === 0) return;

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const prog = this.program.use();
    prog.vec4('uTankRect', p.tankRect[0], p.tankRect[1], p.tankRect[2], p.tankRect[3]);
    prog.vec3a('uLight', p.palette.light);
    prog.vec3a('uFog', p.palette.fog);
    prog.float('uDaylight', p.daylight);
    prog.float('uOpacity', p.opacity);

    this.stats.draws = 0;

    for (let i = 0; i < n; i++) {
      const seed = p.seeds[i];
      const genome = seed ? p.genomes[seed.genome] : undefined;
      if (!seed || !genome) continue;
      const entry = this.meshes.get(genome.id);
      if (!entry) continue;

      const x = p.pose.pos[i * 2] as number;
      const y = p.pose.pos[i * 2 + 1] as number;
      const dx = p.pose.dir[i * 2] as number;
      const dy = p.pose.dir[i * 2 + 1] as number;

      // 死鱼不再摆尾：decay > 0 时把行波冻结，身体保持死亡那一刻的弯曲
      const beatTime = seed.decay > 0 ? Math.max(0, seed.deathAt) : p.timeSeconds;
      const segs = this.buildSpine(genome, x, y, dx, dy, beatTime, unfx(seed.speedScale));
      prog.float('uSpineCount', segs + 1);
      prog.vec2Array('uSpine', this.spine);

      const m = genome.morphology;
      const pat = genome.pattern;
      prog.vec3('uColorBack', entry.colors.back[0], entry.colors.back[1], entry.colors.back[2]);
      prog.vec3('uColorBelly', entry.colors.belly[0], entry.colors.belly[1], entry.colors.belly[2]);
      prog.vec3('uFinColor', entry.colors.fin[0], entry.colors.fin[1], entry.colors.fin[2]);
      prog.float('uStripeFreq', unfx(pat.stripeFreq));
      prog.float('uStripeSharp', unfx(pat.stripeSharp));
      prog.float('uFinAlpha', unfx(pat.finAlpha));
      prog.float('uEyePos', unfx(m.eyePos));
      prog.float('uEyeRadius', unfx(m.eyeRadius));

      // 水深衰减：越靠缸底越融进水色。用鱼在缸内的相对深度。
      const depth = clamp01((y - p.waterLine) / Math.max(0.05, p.sandLine - p.waterLine));
      prog.float('uDepthFog', depth * p.turbidity * 0.55);

      // —— 生态状态的可视化 ——
      // 这是「模拟真的影响画面」最直接的一处：饿着的鱼发灰发暗，
      // 尸体更灰更透明。不用看 HUD 也能一眼看出这一缸过得怎么样。
      const maxE = genome.metabolism.maxEnergy;
      const vitality = maxE > 0 ? clamp01(seed.energy / maxE) : 0.5;
      const decayN = seed.decay > 0 ? clamp01(seed.decay / 1320) : 0;
      prog.float('uVitality', vitality);
      prog.float('uDecay', decayN);

      entry.mesh.draw(entry.indexCount);
      this.stats.draws++;
    }

    gl.disable(gl.BLEND);
  }

  /**
   * 由「身体中心 + 朝向 + 时刻」求出脊柱上的一串点。
   *
   * 摆尾是一条沿身体**从前往后传播**的行波，振幅向尾部迅速增大 ——
   * 这是鱼游动的核心特征：头几乎不动，尾巴摆得最厉害。
   * 振幅取 t² 而不是 t，就是为了让「头稳定、尾甩动」这一点足够明显。
   */
  private buildSpine(
    g: Genome,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    timeSeconds: number,
    speedScale: number,
  ): number {
    const segs = g.morphology.spineSegments;
    const len = unfx(g.morphology.length);
    // 脊柱只占体长的一部分，剩下的留给尾鳍
    const bodyLen = len * 0.60;
    const amp = len * 0.075;

    // 法向强制朝上（缸内 uv 的 y 向下）
    let nx = -dy;
    let ny = dx;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }

    const beat = timeSeconds * BEAT_RATE * (0.55 + 0.75 * speedScale);

    for (let i = 0; i <= segs; i++) {
      const t = segs > 0 ? i / segs : 0;
      const wave = wave01(beat - t * WAVE_LAG) * amp * (0.08 + 0.92 * t * t);
      // 从头到尾：头在朝向的前方，尾在后方
      const along = bodyLen * (0.40 - t);
      this.spine[i * 2] = cx + dx * along + nx * wave;
      this.spine[i * 2 + 1] = cy + dy * along + ny * wave;
    }
    return segs;
  }

  dispose(): void {
    for (const entry of this.meshes.values()) entry.mesh.dispose();
    this.meshes.clear();
    this.program.dispose();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
