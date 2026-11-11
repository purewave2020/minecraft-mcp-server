import type * as Three from 'three';

export interface EntityModel {
  root: Three.Group;
  head: Three.Group | null;
  limbs: { pivot: Three.Group; phase: number }[];
}
const wool = ['#e6e5df', '#df8232', '#b95acb', '#6da1d6', '#dabb29', '#77b02c', '#d3859a', '#45494c',
  '#979793', '#338f99', '#8544b5', '#364b9d', '#715137', '#58752e', '#a63a32', '#262626'];

/** Small block models share geometry/materials and use BlueMap's own Three.js runtime. */
export class EntityModels {
  private readonly geometry: Three.BoxGeometry;
  private readonly materials = new Map<string, { material: Three.MeshBasicMaterial; color: Three.Color }>();
  private brightness = 1;
  constructor(readonly three: typeof Three) {
    this.geometry = new three.BoxGeometry(1, 1, 1);
    const colors: number[] = [];
    for (const shade of [0.78, 0.72, 1, 0.52, 0.9, 0.65]) for (let i = 0; i < 4; i++) colors.push(shade, shade, shade);
    this.geometry.setAttribute('color', new three.Float32BufferAttribute(colors, 3));
  }
  private material(color: string): Three.MeshBasicMaterial {
    let entry = this.materials.get(color);
    if (!entry) {
      const base = new this.three.Color(color);
      const material = new this.three.MeshBasicMaterial({ color: base.clone().multiplyScalar(this.brightness), vertexColors: true });
      entry = { material, color: base }; this.materials.set(color, entry);
    }
    return entry.material;
  }
  light(brightness: number): void {
    if (Math.abs(this.brightness - brightness) < 0.01) return;
    this.brightness = brightness;
    for (const { material, color } of this.materials.values()) material.color.copy(color).multiplyScalar(brightness);
  }
  private box(parent: Three.Group, size: number[], position: number[], color: string): Three.Mesh {
    const mesh = new this.three.Mesh(this.geometry, this.material(color));
    mesh.scale.set(size[0], size[1], size[2]); mesh.position.set(position[0], position[1], position[2]);
    parent.add(mesh); return mesh;
  }
  private pivot(parent: Three.Group, position: number[]): Three.Group {
    const group = new this.three.Group(); group.position.set(position[0], position[1], position[2]); parent.add(group); return group;
  }
  private eyes(head: Three.Group, width: number, y: number, z: number, color = '#1b2528', size = 0.065): void {
    for (const x of [-width, width]) this.box(head, [size, size, 0.025], [x, y, z], color);
  }
  build(type: string, options: { color?: number | null; sheared?: boolean; shirt?: string; armor?: Record<string, string> } = {}): EntityModel {
    const root = new this.three.Group(); const model: EntityModel = { root, head: null, limbs: [] };
    const part = (size: number[], pos: number[], color: string, parent = root) => this.box(parent, size, pos, color);
    const leg = (x: number, y: number, z: number, width: number, height: number, depth: number, color: string, phase: number) => {
      const pivot = this.pivot(root, [x, y, z]); this.box(pivot, [width, height, depth], [0, -height / 2, 0], color);
      model.limbs.push({ pivot, phase }); return pivot;
    };
    const head = (pos: number[], size: number[], color: string) => {
      const group = this.pivot(root, pos); this.box(group, size, [0, 0, 0], color); model.head = group; return group;
    };
    const humanoids = ['player', 'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'villager', 'wandering_trader',
      'zombie_villager', 'pillager', 'vindicator', 'evoker', 'witch', 'enderman', 'piglin', 'piglin_brute', 'zombified_piglin'];
    if (humanoids.includes(type)) {
      const villager = ['villager', 'wandering_trader', 'zombie_villager', 'witch', 'pillager', 'vindicator', 'evoker'].includes(type);
      const illager = ['pillager', 'vindicator', 'evoker'].includes(type);
      const skeleton = ['skeleton', 'stray', 'bogged', 'wither_skeleton'].includes(type);
      const zombie = ['zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin'].includes(type);
      const enderman = type === 'enderman'; const piglin = type.includes('piglin');
      const skin = enderman ? '#242029' : skeleton ? '#c4c5b8' : zombie ? '#6d9855' : piglin ? '#ca9180' : illager ? '#969e96' : villager ? '#b99a78' : '#e6ba91';
      const shirt = enderman ? '#242029' : skeleton ? skin : options.shirt ?? (illager ? '#604647' : villager ? '#79543f' : '#3f9ea3');
      const pants = enderman || skeleton ? skin : villager ? '#5c4130' : '#43558d';
      const legHeight = enderman ? 1.45 : 0.75; const bodyHeight = enderman ? 0.8 : 0.65;
      const armor = options.armor ?? {};
      part([0.5, bodyHeight, 0.26], [0, legHeight + bodyHeight / 2, 0], armor.chest ?? shirt);
      for (const [i, x] of [-0.13, 0.13].entries()) {
        const pivot = leg(x, legHeight, 0, skeleton || enderman ? 0.12 : 0.235, legHeight, 0.25, armor.legs ?? pants, i * Math.PI);
        if (armor.feet) this.box(pivot, [0.25, 0.22, 0.28], [0, -legHeight + 0.11, 0.015], armor.feet);
      }
      const armY = legHeight + bodyHeight;
      if (villager) part([0.65, 0.2, 0.25], [0, armY - 0.35, 0.23], shirt);
      else for (const [i, x] of [-0.36, 0.36].entries()) {
        const arm = leg(x, armY, 0, skeleton || enderman ? 0.11 : 0.21, enderman ? 1.15 : 0.65, 0.24, armor.chest ?? skin, (i + 1) * Math.PI);
        if (zombie) { arm.rotation.x = -Math.PI / 2; model.limbs.pop(); }
      }
      const h = head([0, armY + 0.25, 0], [0.5, 0.5, 0.5], armor.head ?? skin);
      if (type === 'player' && !armor.head) part([0.51, 0.15, 0.51], [0, 0.19, 0], '#44352e', h);
      if (villager) part([0.14, 0.25, 0.18], [0, -0.08, 0.3], skin, h);
      this.eyes(h, 0.13, 0.02, 0.262, enderman ? '#d996e9' : skeleton ? '#3a3e38' : '#273d39', enderman ? 0.1 : 0.07);
      if (skeleton || zombie) part([0.14, 0.04, 0.025], [0, -0.15, 0.263], '#3a4b37', h);
      if (type === 'witch') { part([0.75, 0.08, 0.7], [0, 0.3, 0], '#3c304c', h); part([0.35, 0.55, 0.35], [0, 0.57, 0], '#3c304c', h); }
      if (piglin) part([0.25, 0.13, 0.15], [0, -0.06, 0.3], '#c3827e', h);
    } else if (type === 'iron_golem' || type === 'snow_golem') {
      const iron = type === 'iron_golem'; const color = iron ? '#c7c9b8' : '#e8eeee';
      part([iron ? 1 : 0.7, iron ? 1.2 : 0.7, 0.55], [0, iron ? 1.5 : 0.6, 0], color);
      for (const [i, x] of [-0.27, 0.27].entries()) leg(x, 0.9, 0, 0.3, 0.9, 0.38, color, i * Math.PI);
      for (const [i, x] of [-0.68, 0.68].entries()) leg(x, iron ? 2 : 1.1, 0, iron ? 0.32 : 0.08, iron ? 1.4 : 0.7, 0.3, iron ? color : '#755238', (i + 1) * Math.PI);
      const h = head([0, iron ? 2.35 : 1.35, 0.08], [0.55, 0.6, 0.55], iron ? color : '#c58325');
      this.eyes(h, 0.14, 0.03, 0.288, iron ? '#a23b31' : '#292d29');
      if (iron) { part([0.16, 0.32, 0.2], [0, -0.15, 0.36], '#a4a792', h); part([0.12, 0.7, 0.02], [-0.3, 1.55, 0.29], '#668451'); }
    } else if (type === 'creeper') {
      part([0.5, 0.8, 0.3], [0, 0.8, 0], '#5d9a44');
      const h = head([0, 1.45, 0], [0.6, 0.6, 0.6], '#79ad50');
      this.eyes(h, 0.14, 0.07, 0.312, '#243b22', 0.13);
      part([0.12, 0.19, 0.025], [0, -0.1, 0.315], '#243b22', h);
      for (const x of [-0.09, 0.09]) part([0.08, 0.15, 0.025], [x, -0.18, 0.315], '#243b22', h);
      for (const [i, x] of [-0.16, 0.16].entries()) for (const [j, z] of [-0.22, 0.22].entries()) leg(x, 0.4, z, 0.25, 0.4, 0.3, '#528b3c', (i + j) * Math.PI);
    } else if (['spider', 'cave_spider', 'silverfish', 'endermite'].includes(type)) {
      const color = type === 'cave_spider' ? '#224849' : '#393230';
      part([0.75, 0.45, 0.85], [0, 0.4, -0.2], color);
      const h = head([0, 0.4, 0.5], [0.5, 0.35, 0.4], color); this.eyes(h, 0.14, 0.04, 0.215, '#c63731', 0.08);
      for (const x of [-1, 1]) for (let i = 0; i < 4; i++) {
        const mesh = part([0.65, 0.1, 0.12], [x * 0.6, 0.25, -0.5 + i * 0.33], color); mesh.rotation.z = x * 0.3;
      }
      if (type !== 'spider') root.scale.setScalar(0.65);
    } else if (['slime', 'magma_cube', 'ghast'].includes(type)) {
      const color = type === 'slime' ? '#7daf58' : type === 'magma_cube' ? '#62362b' : '#e4dedb';
      const size = type === 'ghast' ? 2.8 : 0.9;
      const h = head([0, size / 2, 0], [size, size, size], color); this.eyes(h, size * 0.22, size * 0.08, size / 2 + 0.012, '#302d29', size * 0.14);
    } else if (['salmon', 'cod', 'tropical_fish', 'pufferfish', 'squid', 'glow_squid', 'dolphin', 'axolotl', 'tadpole'].includes(type)) {
      const color = type === 'salmon' ? '#b27368' : type === 'glow_squid' ? '#4eaba2' : type === 'squid' ? '#456474' : type === 'axolotl' ? '#e7b4c0' : '#b6a57c';
      part([0.25, 0.32, 0.85], [0, 0.25, 0], color);
      const h = head([0, 0.25, 0.36], [0.27, 0.33, 0.25], color); this.eyes(h, 0.09, 0.05, 0.138, '#263333', 0.045);
      part([0.4, 0.28, 0.08], [0, 0.25, -0.5], color);
    } else if (['chicken', 'parrot', 'bat', 'allay', 'bee', 'phantom', 'vex'].includes(type)) {
      const chicken = type === 'chicken'; const color = chicken ? '#e5e2d2' : type === 'bee' ? '#e0b44e' : type === 'bat' ? '#6d5848' : '#69c8d4';
      part([0.4, 0.45, 0.5], [0, 0.4, 0], color);
      const h = head([0, 0.72, 0.2], [0.3, 0.35, 0.3], color); this.eyes(h, 0.08, 0.02, 0.163, '#2f3430', 0.05);
      part([0.22, 0.1, 0.16], [0, -0.06, 0.21], '#d9a33e', h);
      if (chicken) part([0.1, 0.12, 0.04], [0, -0.18, 0.18], '#b2493b', h);
      for (const [i, x] of [-0.12, 0.12].entries()) leg(x, 0.2, 0, 0.06, 0.2, 0.08, '#bb8a36', i * Math.PI);
      for (const x of [-0.27, 0.27]) part([0.13, 0.25, 0.4], [x, 0.45, 0], color);
    } else {
      const sheep = type === 'sheep'; const pig = type === 'pig'; const cow = type === 'cow' || type === 'mooshroom';
      const horse = ['horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse', 'camel', 'llama', 'trader_llama'].includes(type);
      const wolf = ['wolf', 'cat', 'ocelot', 'fox'].includes(type);
      const color = sheep ? wool[options.color ?? 0] ?? wool[0] : pig ? '#d99b9c' : cow ? '#675044' : type === 'fox' ? '#c77c35' : wolf ? '#b1afa4' : horse ? '#9d7850' : '#8d9b85';
      const legHeight = horse ? 0.85 : wolf ? 0.35 : 0.5; const bodyHeight = wolf ? 0.4 : 0.65;
      const body = sheep && options.sheared ? '#bba99b' : color;
      part([wolf ? 0.45 : 0.75, bodyHeight, horse ? 1.5 : 1], [0, legHeight + bodyHeight / 2, 0], body);
      const h = head([0, legHeight + bodyHeight - 0.08 + (horse ? 0.45 : 0), horse ? 0.75 : 0.6], [wolf ? 0.4 : 0.5, horse ? 0.6 : 0.5, 0.5], sheep ? '#b3a497' : color);
      this.eyes(h, 0.15, 0.05, 0.262);
      if (pig || cow || wolf || horse) part([0.32, 0.2, 0.15], [0, -0.1, 0.3], pig ? '#bc7d84' : cow ? '#bcaaa1' : color, h);
      if (cow) {
        for (const x of [-0.24, 0.24]) part([0.1, 0.22, 0.1], [x, 0.3, 0], '#bdb8a0', h);
        for (const x of [-0.38, 0.38]) part([0.025, 0.3, 0.35], [x, 0.9, 0.1], '#ded9cb');
      }
      if (wolf || horse) for (const x of [-0.17, 0.17]) part([0.12, horse ? 0.28 : 0.17, 0.12], [x, horse ? 0.38 : 0.3, 0], color, h);
      for (const [i, x] of [-0.24, 0.24].entries()) for (const [j, z] of [-0.35, 0.35].entries()) leg(x, legHeight, z * (horse ? 1.5 : 1), 0.17, legHeight, 0.2, sheep ? '#8d8174' : color, (i + j) * Math.PI);
    }
    root.userData.modelType = type;
    return model;
  }
  dispose(): void {
    this.geometry.dispose(); for (const { material } of this.materials.values()) material.dispose(); this.materials.clear();
  }
}
