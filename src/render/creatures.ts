/**
 * 发光生物的渲染。
 *
 * 每只生物画**两遍**，用同一份网格：
 *
 *   pass 0  身体 —— 暗色剪影、边缘光、发光器
 *   pass 1  光晕 —— 网格放大 2.6 倍、加法混合，做出向外溢出的辉光
 *
 * 光晕必须**先画**（在身体之前），否则加法混合会把身体冲淡。
 * 而且光晕要在所有身体之前 —— 所以是「先画完所有光晕，再画所有身体」，
 * 不是「每只生物画完两遍再画下一只」。后者会让相邻生物的光晕
 * 叠在别人的身体上，看起来像一层脏膜。
 *
 * ## 摆尾
 *
 * 沿用顶点着色器里的行波：沿身体从前往后传播，振幅按 t² 增大 ——
 * 头几乎不动，尾摆得最厉害。这是鱼游动的核心特征，
 * 也是所有参考实现（含 Godot 官方文档）一致的做法。
 */

import { MeshProgram, DynamicMesh, type GL } from './gl.js';
import { CREATURE_VS, CREATURE_FS } from './shaders/creature.js';
import {
  buildCreatureMesh,
  CREATURE_VERTEX_LAYOUT,
  MAX_CREATURE_VERTICES,
  MAX_CREATURE_INDICES,
  MAX_SPINE_POINTS,
  SHAPES,
  type ShapeName,
} from './creature-mesh.js';
import { poseAt, type Creature, type Pose2D } from '../core/creatures.js';
import type { Palette } from '../core/theme.js';

/** 摆尾基准频率（次/秒）。深海生物摆得比热带鱼慢得多。 */
const BEAT_RATE = 0.55;
/** 行波沿身体传播的相位差 */
const WAVE_LAG = 1.35;

export interface CreatureFrameParams {
  tankRect: readonly [number, number, number, number];
  creatures: readonly Creature[];
  palette: Palette;
  time: number;
  /** 开场进度 0..1 */
  intro: number;
  opacity: number;
}

export class CreatureRenderer {
  private readonly gl: GL;
  private readonly program: MeshProgram;
  /** 每个体型一份网格 —— 只有 4 份 */
  private readonly meshes = new Map<
    ShapeName,
    { mesh: DynamicMesh; bodyIndexCount: number; haloIndexCount: number }
  >();
  /** 复用的脊柱缓冲，避免每帧分配 */
  private readonly spine = new Float32Array(MAX_SPINE_POINTS * 2);
  readonly stats = { creatures: 0, draws: 0 };

  constructor(gl: GL) {
    this.gl = gl;
    this.program = new MeshProgram(
      gl,
      CREATURE_VS,
      CREATURE_FS,
      CREATURE_VERTEX_LAYOUT.map((a) => a.name),
    );
    this.buildMeshes();
  }

  private buildMeshes(): void {
    for (const name of Object.keys(SHAPES) as ShapeName[]) {
      const shape = SHAPES[name];
      const data = buildCreatureMesh(shape);
      const mesh = new DynamicMesh(
        this.gl,
        CREATURE_VERTEX_LAYOUT,
        this.program,
        MAX_CREATURE_VERTICES,
        MAX_CREATURE_INDICES,
      );
      mesh.update(data.vertices, data.indices);
      this.meshes.set(name, {
        mesh,
        bodyIndexCount: data.bodyIndexCount,
        haloIndexCount: data.haloIndexCount,
      });
    }
  }

  /**
   * 算出这一帧全部生物的姿态与脊柱。
   *
   * 姿态是纯函数（位置只取决于时间），脊柱是每帧现算的 ——
   * CPU 每帧的工作量与顶点数无关，只与生物的**只数**有关。
   */
  render(p: CreatureFrameParams): void {
    const gl = this.gl;
    const list = p.creatures;
    if (list.length === 0) return;

    this.stats.creatures = list.length;
    this.stats.draws = 0;

    // 准备一遍：把每只生物的姿态算好，避免两个 pass 各算一次
    const poses: Pose2D[] = [];
    for (const c of list) {
      const pose: Pose2D = { x: 0, y: 0, dx: 1, dy: 0 };
      poseAt(c, p.time, pose);
      poses.push(pose);
    }

    gl.enable(gl.BLEND);

    // ——————— pass 1：光晕（先画，且全部画完）———————
    gl.blendFunc(gl.ONE, gl.ONE); // 加法
    const prog = this.program.use();
    prog.vec4('uTankRect', p.tankRect[0], p.tankRect[1], p.tankRect[2], p.tankRect[3]);
    prog.float('uPass', 1);
    // 光晕环已经烘在网格里了，**不再放大网格** —— 放大只会得到一层
    // 飘在外面的硬壳，衰减在那里早就归零了
    prog.float('uHaloScale', 1);
    prog.float('uTime', p.time);
    prog.vec3('uBodyDark', 0, 0, 0);
    prog.float('uGlowStrength', 1);

    for (let i = 0; i < list.length; i++) {
      const c = list[i] as Creature;
      const entry = this.meshes.get(c.shape);
      if (!entry) continue;
      const pose = poses[i] as Pose2D;
      const segs = this.buildSpine(c, pose, p.time);
      prog.float('uSpineCount', segs + 1);
      prog.vec2Array('uSpine', this.spine);
      this.setCreatureUniforms(prog, c, p, /* halo */ true);
      entry.mesh.draw(entry.haloIndexCount, entry.bodyIndexCount);
      this.stats.draws++;
    }

    // ——————— pass 2：身体 ———————
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    prog.float('uPass', 0);
    prog.float('uHaloScale', 1);

    for (let i = 0; i < list.length; i++) {
      const c = list[i] as Creature;
      const entry = this.meshes.get(c.shape);
      if (!entry) continue;
      const pose = poses[i] as Pose2D;
      const segs = this.buildSpine(c, pose, p.time);
      prog.float('uSpineCount', segs + 1);
      prog.vec2Array('uSpine', this.spine);
      this.setCreatureUniforms(prog, c, p, /* halo */ false);
      entry.mesh.draw(entry.bodyIndexCount, 0);
      this.stats.draws++;
    }

    gl.disable(gl.BLEND);
  }

  /** 每只生物自己的颜色与亮度。 */
  private setCreatureUniforms(
    prog: ReturnType<MeshProgram['use']>,
    c: Creature,
    p: CreatureFrameParams,
    halo: boolean,
  ): void {
    const base = c.alt ? p.palette.glowAlt : p.palette.glow;

    // 出声的标签页缓慢脉动 —— 比在旁边放个小喇叭图标直观得多
    const pulse = c.audible ? 1 + Math.sin(p.time * 1.5 + c.p1) * 0.38 : 1;

    // 亮度 = 标签页状态 × 开场进度 × 个体渐显
    const intro = Math.min(1, Math.max(0, p.intro * 1.35 - (c.id % 7) * 0.05));
    const strength = c.energy * pulse * intro * c.fade;

    prog.vec3('uGlow', base[0], base[1], base[2]);

    if (halo) {
      // 光晕刻意做得很淡：它是「溢出」而不是「描边」。
      // 调高会立刻变成一团糊掉的光斑，把生物的形状吃掉。
      prog.float('uHaloStrength', 0.55 * strength * p.palette.bloom);
      prog.float('uOpacity', p.opacity * Math.min(1, c.fade));
    } else {
      prog.float('uGlowStrength', strength * (0.85 + p.palette.bloom * 0.25));
      // 身体的底色：非常暗，但要带一点冷色，纯黑会显得像剪影贴纸
      // 身体的底色。要**明显比水亮一点**，否则在近黑背景上剪影完全看不见，
      // 一条鱼就只剩一根发光的肚线。但也不能太亮 —— 一旦接近辉光的亮度，
      // 「暗剪影 + 亮点」的对比就没了，生物会变成一块发光的色斑。
      prog.vec3(
        'uBodyDark',
        p.palette.waterDeep[0] * 9.0 + 0.005,
        p.palette.waterDeep[1] * 9.0 + 0.011,
        p.palette.waterDeep[2] * 9.0 + 0.020,
      );
      prog.float('uOpacity', p.opacity * Math.min(1, c.fade));
    }
  }

  /**
   * 由「中心 + 朝向 + 时刻」求出脊柱上的一串点。
   *
   * 头在前、尾在后，摆尾是一条沿身体**从前往后传播**的行波，
   * 振幅按 t² 增大 —— 头几乎不动，尾摆得最厉害。
   */
  private buildSpine(c: Creature, pose: Pose2D, time: number): number {
    const shape = SHAPES[c.shape];
    const segs = shape.segments;

    // 摆尾的振幅和频率都跟着体型走：带鱼摆得又慢又大，灯笼鱼又快又小
    const bodyLen = shape.length * c.scale;
    const amp = bodyLen * (c.shape === 'ribbon' ? 0.16 : 0.085);
    const beat = time * BEAT_RATE * c.speed * (c.shape === 'ribbon' ? 0.75 : 1.15);

    // 法向强制朝上（缸内 uv 的 y 向下）
    let nx = -pose.dy;
    let ny = pose.dx;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }

    // 蛰伏的生物几乎不摆尾
    const activity = 0.25 + 0.75 * Math.min(1, c.energy);

    for (let i = 0; i <= segs; i++) {
      const t = segs > 0 ? i / segs : 0;
      // 沿身体的基准位置：头在 +0.42，尾根在 −0.50
      const along = bodyLen * (0.42 - t * 0.92);
      // 行波，振幅向尾部迅速增大
      const wave =
        Math.sin(beat - t * WAVE_LAG) * amp * (0.06 + 0.94 * t * t) * activity;
      this.spine[i * 2] = pose.x + pose.dx * along + nx * wave;
      this.spine[i * 2 + 1] = pose.y + pose.dy * along + ny * wave;
    }
    return segs;
  }

  dispose(): void {
    for (const e of this.meshes.values()) e.mesh.dispose();
    this.meshes.clear();
    this.program.dispose();
  }
}
