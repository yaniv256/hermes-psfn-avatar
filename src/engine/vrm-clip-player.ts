/**
 * Plays baked ARDY Core-27 clips (clips/*.json) on a VRM or Holo-Rig humanoid.
 * Ported from /home/vega/Projects/psfn/avatar-demo/vrm-clip-player.js.
 */

import { Euler, MathUtils, Quaternion, Vector3, type Object3D } from 'three';

/**
 * World-space coronal abduction (+Z/-Z) and forward clearance (-X) offsets so
 * SMPL/ARDY motion-capture clips clear anime VRM sleeves, dresses, and hair curls
 * instead of pressing elbows/forearms inward into the torso.
 */
const WORLD_ARM_CLEARANCE_OFFSETS: Readonly<Record<string, Quaternion>> = {
  leftShoulder: new Quaternion().setFromEuler(new Euler(0, 0, 0.05, 'XYZ')),
  rightShoulder: new Quaternion().setFromEuler(new Euler(0, 0, -0.05, 'XYZ')),
  leftUpperArm: new Quaternion().setFromEuler(new Euler(-0.06, 0, 0.22, 'XYZ')),
  rightUpperArm: new Quaternion().setFromEuler(new Euler(-0.06, 0, -0.22, 'XYZ')),
  leftLowerArm: new Quaternion().setFromEuler(new Euler(-0.10, 0, 0.26, 'XYZ')),
  rightLowerArm: new Quaternion().setFromEuler(new Euler(-0.10, 0, -0.26, 'XYZ')),
  leftHand: new Quaternion().setFromEuler(new Euler(-0.08, 0, 0.22, 'XYZ')),
  rightHand: new Quaternion().setFromEuler(new Euler(-0.08, 0, -0.22, 'XYZ')),
  leftThumbMetacarpal: new Quaternion().setFromEuler(new Euler(-0.08, 0, 0.22, 'XYZ')),
  rightThumbMetacarpal: new Quaternion().setFromEuler(new Euler(-0.08, 0, -0.22, 'XYZ')),
};

export const BONE_MAP: Readonly<Record<string, string | null>> = {
  Hips: 'hips',
  Spine: 'spine',
  Spine1: 'chest',
  Spine2: 'upperChest',
  Spine3: null,
  Neck: 'neck',
  Head: 'head',
  RightShoulder: 'rightShoulder',
  RightArm: 'rightUpperArm',
  RightForeArm: 'rightLowerArm',
  RightHand: 'rightHand',
  RightHandEnd: null,
  RightHandThumb1: 'rightThumbMetacarpal',
  LeftShoulder: 'leftShoulder',
  LeftArm: 'leftUpperArm',
  LeftForeArm: 'leftLowerArm',
  LeftHand: 'leftHand',
  LeftHandEnd: null,
  LeftHandThumb1: 'leftThumbMetacarpal',
  RightUpLeg: 'rightUpperLeg',
  RightLeg: 'rightLowerLeg',
  RightFoot: 'rightFoot',
  RightToeBase: 'rightToes',
  LeftUpLeg: 'leftUpperLeg',
  LeftLeg: 'leftLowerLeg',
  LeftFoot: 'leftFoot',
  LeftToeBase: 'leftToes',
};

/**
 * How much of each clip's motion reaches the trunk and head. The clips are full-body motion capture, framed for a
 * whole figure; at a face close-up their head turns, bows and forward leans carry the face out of frame. Each
 * factor scales the bone's world-space rotation away from its rest pose (1 = as captured, 0 = held at rest). Arms and
 * legs keep the full clip.
 */
export const DEFAULT_TRUNK_MOTION: Readonly<Record<string, number>> = {
  hips: 0.5,
  spine: 0.5,
  chest: 0.5,
  upperChest: 0.5,
  neck: 0.45,
  head: 0.4,
};

/** Share of the clip's root translation (sway, steps, leaning toward the camera) that moves the hips. */
export const DEFAULT_ROOT_MOTION = 0.3;

/**
 * Extra damping for clips whose trunk motion is large even after DEFAULT_TRUNK_MOTION, keyed by clip file name
 * (without .json). It multiplies both the trunk/head shares and the root share. Neutral_Listening_01 is a
 * "leaning in" listen: the head bows about 50 degrees and the hips move forward by 14% of their height, which at a
 * face close-up pushes the face toward the camera until the chin leaves the frame.
 */
export const CLIP_MOTION_SCALE: Readonly<Record<string, number>> = {
  Neutral_Listening_01: 0.5,
};

/** CLIP_MOTION_SCALE entry for a clip URL, or 1. */
export function clipMotionScale(url: string): number {
  const name = url.split(/[?#]/)[0]!.split('/').pop()!.replace(/\.json$/i, '');
  return CLIP_MOTION_SCALE[name] ?? 1;
}

export interface BakedMotionClip {
  readonly bones: readonly string[];
  readonly frames: number;
  readonly fps: number;
  readonly restGlobalQuat: readonly (readonly number[])[];
  readonly rootPos: readonly (readonly number[])[];
  readonly globalQuat: readonly (readonly (readonly number[])[])[];
}

interface BoneMapEntry {
  readonly coreIdx: number;
  readonly vrmName: string;
  readonly node: Object3D;
  readonly coreRestInv: Quaternion;
  readonly vrmRestGlobal: Quaternion;
  readonly restLocal: Quaternion;
}

export type ClipFetcher = (url: string) => Promise<BakedMotionClip>;

export class VrmClipPlayer {
  readonly getBoneNode: (vrmHumanoidName: string) => Object3D | null;
  readonly hipsRestPos: Vector3 | null;
  readonly fetchClip: ClipFetcher;
  clip: BakedMotionClip | null = null;
  url: string | null = null;
  playing = false;
  t = 0;
  completedLoops = 0;
  loop = true;
  /** Per-model multiplier for WORLD_ARM_CLEARANCE_OFFSETS (0 = raw clip arms, 1 = default spread). */
  armClearance = 1;
  /** Per-bone share of the clip's trunk/head rotation; see DEFAULT_TRUNK_MOTION. */
  trunkMotion: Record<string, number> = { ...DEFAULT_TRUNK_MOTION };
  /** Share of the clip's root translation; see DEFAULT_ROOT_MOTION. */
  rootMotion = DEFAULT_ROOT_MOTION;
  /** CLIP_MOTION_SCALE of the loaded clip, applied on top of trunkMotion and rootMotion. */
  clipScale = 1;

  private _maps: BoneMapEntry[] = [];
  private _q = new Quaternion();
  private _q2 = new Quaternion();
  private _q3 = new Quaternion();
  private _cache = new Map<string, Promise<BakedMotionClip>>();
  private _loadSequence = 0;
  private _coreRoot0 = new Vector3();
  private _fade: {
    duration: number;
    elapsed: number;
    poses: Map<Object3D, Quaternion>;
    root: Vector3 | undefined;
  } | null = null;
  private _rest = new Map<
    string,
    { node: Object3D; global: Quaternion; local: Quaternion }
  >();

  constructor(
    getBoneNode: (vrmHumanoidName: string) => Object3D | null,
    hipsRestPos: Vector3 | null,
    fetchClip?: ClipFetcher,
  ) {
    this.getBoneNode = getBoneNode;
    this.hipsRestPos = hipsRestPos ? hipsRestPos.clone() : null;
    this.fetchClip =
      fetchClip ??
      (async (url: string) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`clip fetch ${res.status}: ${url}`);
        return (await res.json()) as BakedMotionClip;
      });

    for (const name of Object.values(BONE_MAP)) {
      if (!name) continue;
      const node = getBoneNode(name);
      if (node) {
        this._rest.set(name, {
          node,
          global: node.getWorldQuaternion(new Quaternion()),
          local: node.quaternion.clone(),
        });
      }
    }
  }

  async preload(url: string): Promise<BakedMotionClip> {
    if (!this._cache.has(url)) {
      this._cache.set(
        url,
        (async () => {
          const clip = await this.fetchClip(url);
          const validVectors = (
            rows: unknown,
            count: number,
            width: number,
          ): boolean =>
            Array.isArray(rows) &&
            rows.length === count &&
            rows.every(
              (row) =>
                Array.isArray(row) &&
                row.length === width &&
                row.every(Number.isFinite),
            );
          const n = clip?.bones?.length ?? 0;
          if (
            !n ||
            !Number.isInteger(clip.frames) ||
            clip.frames < 2 ||
            !(clip.fps > 0) ||
            !Number.isFinite(clip.fps) ||
            !validVectors(clip.restGlobalQuat, n, 4) ||
            !validVectors(clip.rootPos, clip.frames, 3) ||
            !Array.isArray(clip.globalQuat) ||
            clip.globalQuat.length !== clip.frames ||
            !clip.globalQuat.every((frame) => validVectors(frame, n, 4))
          ) {
            throw new Error(`Invalid motion clip: ${url}`);
          }
          return clip;
        })().catch((error) => {
          this._cache.delete(url);
          throw error;
        }),
      );
    }
    return this._cache.get(url)!;
  }

  cancelPendingLoad(): void {
    this._loadSequence++;
  }

  async load(url: string): Promise<this> {
    const sequence = ++this._loadSequence;
    const clip = await this.preload(url);
    if (sequence !== this._loadSequence) return this;
    this.clip = clip;
    this.url = url;
    this.clipScale = clipMotionScale(url);
    this._maps = [];
    const bones = clip.bones;
    for (let i = 0; i < bones.length; i++) {
      const vrmName = BONE_MAP[bones[i]!];
      if (!vrmName) continue;
      const rest = this._rest.get(vrmName);
      if (!rest) continue;
      const coreRest = new Quaternion().fromArray(clip.restGlobalQuat[i]!).normalize();
      this._maps.push({
        coreIdx: i,
        vrmName,
        node: rest.node,
        coreRestInv: coreRest.clone().invert(),
        vrmRestGlobal: rest.global,
        restLocal: rest.local,
      });
    }
    this._coreRoot0 = new Vector3().fromArray(this.clip.rootPos[0]!);
    this.t = 0;
    this.completedLoops = 0;
    return this;
  }

  play({ loop = true, fadeSeconds = 0 }: { loop?: boolean; fadeSeconds?: number } = {}): void {
    this.loop = loop;
    this.playing = true;
    this._fade =
      fadeSeconds > 0
        ? {
            duration: fadeSeconds,
            elapsed: 0,
            poses: new Map(this._maps.map((m) => [m.node, m.node.quaternion.clone()])),
            root: this.getBoneNode('hips')?.position.clone(),
          }
        : null;
  }

  stop(): void {
    this.playing = false;
  }

  get duration(): number {
    return this.clip ? this.clip.frames / this.clip.fps : 0;
  }

  update(dt: number): void {
    if (!this.playing || !this.clip) return;
    this.t += dt;
    const dur = this.duration;
    if (this.t >= dur) {
      if (this.loop) {
        this.completedLoops += Math.floor(this.t / dur);
        this.t %= dur;
      } else {
        this.t = dur;
        this.playing = false;
      }
    }
    const ft = this.t * this.clip.fps;
    const f0 = Math.min(Math.floor(ft), this.clip.frames - 1);
    const f1 = Math.min(f0 + 1, this.clip.frames - 1);
    const a = ft - f0;
    const tail = Math.min(0.4, dur / 3);
    const blend = this.loop ? MathUtils.smoothstep(this.t, dur - tail, dur) : 0;
    const fade = this._fade;
    if (fade) fade.elapsed += dt;
    const fadeWeight = fade ? MathUtils.smoothstep(fade.elapsed, 0, fade.duration) : 1;

    for (const m of this._maps) {
      const q0 = this._q.fromArray(this.clip.globalQuat[f0]![m.coreIdx]!).normalize();
      const q1 = this._q2.fromArray(this.clip.globalQuat[f1]![m.coreIdx]!).normalize();
      q0.slerp(q1, a);
      if (blend) {
        q0.slerp(q1.fromArray(this.clip.globalQuat[0]![m.coreIdx]!).normalize(), blend);
      }
      // world-space rotation away from rest, damped for the trunk and head
      const delta = q0.clone().multiply(m.coreRestInv);
      const base = this.trunkMotion[m.vrmName];
      const share = base === undefined ? undefined : base * this.clipScale;
      if (share !== undefined && share !== 1) delta.copy(this._q3.identity().slerp(delta, Math.max(0, share)));
      const targetGlobal = delta.multiply(m.vrmRestGlobal);
      const clearance = WORLD_ARM_CLEARANCE_OFFSETS[m.vrmName];
      if (clearance && this.armClearance > 0) {
        targetGlobal.premultiply(
          this.armClearance === 1 ? clearance : this._q3.identity().slerp(clearance, this.armClearance),
        );
      }
      const parentGlobal = m.node.parent
        ? m.node.parent.getWorldQuaternion(new Quaternion())
        : new Quaternion();
      m.node.quaternion.copy(parentGlobal.clone().invert().multiply(targetGlobal));
      m.node.updateMatrixWorld(true);
    }

    if (this.hipsRestPos) {
      const hips = this._maps.find((m) => m.vrmName === 'hips');
      if (hips) {
        const r0 = new Vector3().fromArray(this.clip.rootPos[f0]!);
        const r1 = new Vector3().fromArray(this.clip.rootPos[f1]!);
        r0.lerp(r1, a).lerp(this._coreRoot0, blend).sub(this._coreRoot0);
        const scale = this._coreRoot0.y > 1e-4 ? this.hipsRestPos.y / this._coreRoot0.y : 1;
        hips.node.position.copy(this.hipsRestPos).addScaledVector(r0, scale * Math.max(0, this.rootMotion * this.clipScale));
        if (fade?.root) {
          hips.node.position.lerpVectors(fade.root, hips.node.position, fadeWeight);
        }
      }
    }

    if (fade) {
      for (const m of this._maps) {
        const prev = fade.poses.get(m.node);
        if (prev) {
          this._q.copy(m.node.quaternion);
          m.node.quaternion.slerpQuaternions(prev, this._q, fadeWeight);
        }
      }
    }
    if (fadeWeight === 1) this._fade = null;
  }
}
