import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

test('42 baked ARDY motion clips and clips.json manifest are valid', () => {
  const clipsDir = path.join(ROOT, 'clips');
  const manifest = JSON.parse(fs.readFileSync(path.join(clipsDir, 'clips.json'), 'utf8'));
  assert.equal(Array.isArray(manifest), true);
  assert.equal(manifest.length, 42);

  for (const entry of manifest) {
    const filename = path.basename(entry.url);
    const clipPath = path.join(clipsDir, filename);
    assert.equal(fs.existsSync(clipPath), true, `Missing clip file ${filename}`);
    const clip = JSON.parse(fs.readFileSync(clipPath, 'utf8'));
    assert.equal(Array.isArray(clip.bones), true);
    assert.equal(clip.bones.length, 27);
    assert.equal(clip.frames >= 2, true);
    assert.equal(clip.fps > 0, true);
    assert.equal(clip.globalQuat.length, clip.frames);
    assert.equal(clip.rootPos.length, clip.frames);
  }
});

test('3D Holo-Rig, VrmClipPlayer, CompanionPlayer mood envelopes, and emotion mapping execute end-to-end', async () => {
  // Bundle the TS engine modules in memory and import them as a data URL
  const bundled = await build({
    stdin: {
      contents: `
        export * from './src/engine/emotion-mapping.ts';
        export * from './src/engine/interactions.ts';
        export * from './src/engine/holo-avatar.ts';
        export * from './src/engine/vrm-clip-player.ts';
        export * from './src/engine/companion-player.ts';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  const code = bundled.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

  // 1. Emotion mapping (VAD + discrete GoEmotions override)
  assert.equal(mod.vadQuadrantBase({ valence: 0.8, arousal: 0.75, dominance: 0.2 }), 'excited');
  assert.equal(mod.vadQuadrantBase({ valence: -0.6, arousal: 0.65, dominance: -0.5 }), 'anxious');
  assert.equal(
    mod.emotionalBaseFromSnapshot({
      vector: { valence: 0.1, arousal: 0.1, dominance: 0 },
      discrete: [{ label: 'curiosity', score: 0.82 }],
    }),
    'curious',
  );

  // 2. Touch gesture classifier
  const g = mod.classifyAvatarGesture(
    { durationMs: 120, deltaX: 2, deltaY: 3, sinceLastTapMs: 900 },
    ['tap', 'drag'],
  );
  assert.equal(g, 'tap');
  assert.deepEqual(mod.mapAvatarInteraction('head', g, 120), {
    kind: 'headpat',
    region: 'head',
    durationMs: 120,
  });

  // 3. Holo-Rig + VrmClipPlayer + CompanionPlayer on real baked ARDY clips
  const holo = mod.createHoloAvatar();
  const head = holo.getBoneNode('head');
  const leftUpperArm = holo.getBoneNode('leftUpperArm');
  assert.ok(head);
  assert.ok(leftUpperArm);
  const restArmQuat = leftUpperArm.quaternion.clone();

  const clipsDir = path.join(ROOT, 'clips');
  const manifest = JSON.parse(fs.readFileSync(path.join(clipsDir, 'clips.json'), 'utf8'));
  const fetchClip = async (url) => {
    const file = path.basename(url);
    return JSON.parse(fs.readFileSync(path.join(clipsDir, file), 'utf8'));
  };

  const audio = { speechTime: null, speechLevel: 0 };
  const clipPlayer = new mod.VrmClipPlayer(
    (name) => holo.getBoneNode(name),
    holo.getBoneNode('hips').position,
    fetchClip,
  );
  const companion = new mod.CompanionPlayer(clipPlayer, holo.expressionManager, audio);
  await companion.init(manifest, true);
  await companion.select('Idle');
  companion.update(0.25, { enabled: true });
  holo.update(0.25, 0.25);

  // Verify T-pose arm rotated into relaxed idle stance
  assert.equal(leftUpperArm.quaternion.equals(restArmQuat), false);

  // Preview Joy mood clip and verify facial expression envelope rises
  await companion.preview('./clips/Joy_Mood_01.json', false);
  companion.update(0.35, { enabled: true });
  holo.update(0.35, 0.6);
  assert.equal(holo.expressionManager.getValue('joy') > 0.5, true);

  // Simulate speaking and verify `aa` lip-sync weight rises
  audio.speechTime = 0.2;
  audio.speechLevel = 0.85;
  companion.update(0.1, { enabled: true });
  assert.equal(holo.expressionManager.getValue('aa') > 0.3, true);

  // Simulate tool use / thinking with no TTS audio: selects Thinking state, closes mouth,
  // and rotates through the 9-clip calm idle + hand-to-chin pondering sequence
  audio.speechTime = null;
  audio.speechLevel = 0;
  companion.setMode('auto');
  companion.update(0.65, { thinking: true, enabled: true });
  assert.equal(companion.state, 'Thinking');
  assert.equal(holo.expressionManager.getValue('aa'), 0);
  await new Promise((r) => setTimeout(r, 20));
  const firstThinkingUrl = clipPlayer.url;
  assert.ok(firstThinkingUrl.endsWith('Curiosity_Mood_02.json'));
  clipPlayer.completedLoops = 1;
  companion.update(0.1, { thinking: true, enabled: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(clipPlayer.url.endsWith('Neutral_Idle_01.json'));

  companion.dispose();
  holo.dispose();
});

test('desktop/plugin.js and dashboard/dist/index.js bundles exist and stay under 1MB', () => {
  const desktopBundle = path.join(ROOT, 'desktop', 'plugin.js');
  const dashboardBundle = path.join(ROOT, 'dashboard', 'dist', 'index.js');
  assert.equal(fs.existsSync(desktopBundle), true);
  assert.equal(fs.existsSync(dashboardBundle), true);

  const desktopSizeKb = fs.statSync(desktopBundle).size / 1024;
  const dashboardSizeKb = fs.statSync(dashboardBundle).size / 1024;
  assert.equal(desktopSizeKb < 1024, true, `desktop/plugin.js is ${desktopSizeKb}KB`);
  assert.equal(dashboardSizeKb < 1024, true, `dashboard/dist/index.js is ${dashboardSizeKb}KB`);
});

async function importSpeechCadence() {
  const bundled = await build({
    entryPoints: [path.join(ROOT, 'src', 'engine', 'speech-cadence.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  const code = bundled.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/** A stand-in for the host's read-only voice door, driven by the test. */
function fakeVoice() {
  const store = (initial) => {
    let value = initial;
    const subs = new Set();
    return {
      get: () => value,
      subscribe(cb) {
        subs.add(cb);
        cb(value);
        return () => subs.delete(cb);
      },
      listen(cb) {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      put(next) {
        value = next;
        for (const cb of subs) cb(value);
      },
    };
  };
  const idle = { status: 'idle', source: null, messageId: null, endReason: null, endDetail: null };
  const playback = store(idle);
  const timeline = store({ segments: [] });
  let level = 0;
  let latencyMs = 0;
  return {
    door: {
      playback,
      timeline,
      level: () => level,
      outputLatencyMs: () => latencyMs,
    },
    setLatency(next) {
      latencyMs = next;
    },
    put(next) {
      playback.put({ source: 'chained', messageId: 'm1', endReason: null, endDetail: null, ...next });
    },
    speak() {
      playback.put({ status: 'speaking', source: 'chained', messageId: 'm1', endReason: null, endDetail: null });
    },
    end(endReason) {
      playback.put({ status: 'idle', source: null, messageId: null, endReason, endDetail: null });
    },
    setTimeline(segments) {
      timeline.put({ segments });
    },
    setLevel(next) {
      level = next;
    },
  };
}

const maxViseme = (sample) => Math.max(...Object.values(sample.visemes));

test('without a voice door the mouth follows the text-guess timeline', async () => {
  const mod = await importSpeechCadence();
  const text = 'Hello there, my friend! How are you doing today?';
  const segments = mod.buildTimeline(text);
  const cadence = mod.createSpeechCadence();
  const dt = 0.02;
  cadence.sample(dt);
  let clock = dt;
  cadence.noteReply(text);
  const start = clock + 0.7;
  let mouthed = 0;
  for (let i = 0; i < 400; i++) {
    const sample = cadence.sample(dt);
    clock += dt;
    const at = clock - start;
    const seg = at >= 0 ? segments.find((s) => s.end > at) : undefined;
    if (!seg) {
      assert.equal(sample.speaking, false, `silent at ${at.toFixed(2)}s`);
      continue;
    }
    assert.equal(sample.speaking, true, `speaking at ${at.toFixed(2)}s`);
    assert.equal(sample.level, seg.open);
    const shape = mod.shapeVisemes(seg.vowel, seg.open);
    for (const v of ['aa', 'ih', 'ou', 'ee', 'oh']) {
      assert.equal(sample.visemes[v], shape[v], `${v} at ${at.toFixed(2)}s`);
    }
    if (maxViseme(sample) > 0) mouthed++;
  }
  assert.ok(mouthed > 50);
});

test('a timed word piece shapes the mouth only inside its window', async () => {
  const mod = await importSpeechCadence();
  const voice = fakeVoice();
  let now = 0;
  const cadence = mod.createSpeechCadence({ voice: voice.door, now: () => now });
  voice.setTimeline([
    {
      text: 'hello',
      startMs: 1000,
      endMs: 1400,
      pieces: [{ text: 'hello', kind: 'word', startMs: 1000, endMs: 1400, charStart: 0, charEnd: 5 }],
    },
  ]);
  voice.setLevel(0.5);
  voice.speak();
  // A text-guess reply must not override the timed pieces.
  cadence.noteReply('This reply text should not drive the mouth at all.');
  let firstEe = Infinity;
  let lastOh = -Infinity;
  for (now = 800; now <= 1600; now += 5) {
    const sample = cadence.sample(0.005);
    assert.equal(sample.speaking, true);
    const inside = now >= 1000 && now < 1400;
    if (!inside) {
      assert.equal(maxViseme(sample), 0, `closed at ${now}ms`);
      continue;
    }
    if (sample.visemes.ee > 0.3) firstEe = Math.min(firstEe, now);
    if (sample.visemes.oh > 0.3) lastOh = Math.max(lastOh, now);
  }
  // The word's sounds are spread across the piece: "e" early, "o" late.
  assert.ok(firstEe >= 1000 && firstEe < 1200, `ee first at ${firstEe}`);
  assert.ok(lastOh > 1250 && lastOh < 1400, `oh last at ${lastOh}`);
});

test('with loudness but no timed pieces, mouth openness follows the level', async () => {
  const mod = await importSpeechCadence();
  const voice = fakeVoice();
  let now = 0;
  const cadence = mod.createSpeechCadence({ voice: voice.door, now: () => now });
  voice.setTimeline([
    {
      text: 'A whole sentence.',
      startMs: 0,
      endMs: Infinity,
      pieces: [{ text: 'A whole sentence.', kind: 'sentence', startMs: 0, endMs: Infinity }],
    },
  ]);
  voice.speak();
  const openness = [];
  for (const level of [0, 0.05, 0.1, 0.2, 0.3]) {
    voice.setLevel(level);
    now += 16;
    const sample = cadence.sample(0.016);
    assert.equal(sample.speaking, true);
    openness.push(sample.level);
    assert.equal(maxViseme(sample) > 0, level > 0, `shape at level ${level}`);
  }
  assert.ok(openness[0] < 0.02, `closed at level 0: ${openness[0]}`);
  for (let i = 1; i < openness.length; i++) assert.ok(openness[i] > openness[i - 1], `rises with the level: ${openness}`);
  assert.ok(openness[openness.length - 1] > 0.5);

  // An empty timeline behaves the same way.
  voice.setTimeline([]);
  voice.setLevel(0.3);
  now += 16;
  assert.ok(cadence.sample(0.016).level > 0.5);
});

test('a piece still open while the audio is silent keeps the mouth nearly closed', async () => {
  const mod = await importSpeechCadence();
  const voice = fakeVoice();
  let now = 0;
  const cadence = mod.createSpeechCadence({ voice: voice.door, now: () => now });
  voice.setTimeline([
    {
      text: 'later',
      startMs: 0,
      endMs: 600,
      pieces: [{ text: 'later', kind: 'fragment', startMs: 0, endMs: 600 }],
    },
  ]);
  voice.speak();
  voice.setLevel(0.003);
  for (now = 0; now < 600; now += 10) {
    const sample = cadence.sample(0.01);
    assert.ok(maxViseme(sample) < 0.05, `near closed at ${now}ms: ${maxViseme(sample)}`);
    assert.ok(sample.level < 0.05);
  }
});

test('interrupted speech closes the mouth at once; finished speech eases it shut', async () => {
  const mod = await importSpeechCadence();
  for (const endReason of ['interrupted', 'stopped', 'replaced', 'closed', 'finished']) {
    const voice = fakeVoice();
    let now = 0;
    const cadence = mod.createSpeechCadence({ voice: voice.door, now: () => now });
    const mouth = mod.createMouth();
    voice.setTimeline([]);
    voice.setLevel(0.4);
    voice.speak();
    let state;
    for (let i = 0; i < 20; i++) {
      now += 16;
      state = mouth.update(cadence.sample(0.016), 0.016);
    }
    assert.ok(maxViseme(state) > 0.2, `open before ${endReason}`);
    voice.setLevel(0);
    voice.end(endReason);
    now += 16;
    state = mouth.update(cadence.sample(0.016), 0.016);
    if (endReason === 'finished') {
      assert.ok(maxViseme(state) > 0.05, `finished eases: ${maxViseme(state)}`);
      assert.ok(state.level > 0.05);
      for (let i = 0; i < 20; i++) {
        now += 16;
        state = mouth.update(cadence.sample(0.016), 0.016);
      }
      assert.equal(maxViseme(state), 0, 'finished ends closed');
    } else {
      assert.equal(maxViseme(state), 0, `${endReason} closes at once`);
      assert.equal(state.level, 0);
      assert.equal(state.talking, false);
    }
  }
});

test('with a voice door present but idle, reply text alone does not move the mouth', async () => {
  const mod = await importSpeechCadence();
  const voice = fakeVoice();
  let now = 0;
  const cadence = mod.createSpeechCadence({ voice: voice.door, now: () => now });
  cadence.noteReply('Hello there, my friend!');
  for (let i = 0; i < 200; i++) {
    now += 16;
    const sample = cadence.sample(0.016);
    assert.equal(sample.speaking, false);
    assert.equal(maxViseme(sample), 0);
  }
});

test('the level scale opens the mouth for ordinary speech and keeps it shut on noise', async () => {
  const mod = await importSpeechCadence();
  const voice = fakeVoice();
  let now = 0;
  const cadence = mod.createSpeechCadence({ voice: voice.door, now: () => now });
  voice.setTimeline([]);
  voice.speak();
  const openAt = (level) => {
    voice.setLevel(level);
    now += 16;
    return cadence.sample(0.016).level;
  };
  assert.equal(openAt(0.03), 0, 'background noise stays closed');
  const ordinary = openAt(0.2);
  assert.ok(ordinary >= 0.6, `ordinary speech opens the mouth: ${ordinary}`);
  assert.ok(openAt(0.1) > 0.15, 'quiet speech still opens it a little');
  assert.equal(openAt(1), 0.85, 'loud speech opens it fully');
});

test('the level is read on the listener clock, delayed by the output latency', async () => {
  const mod = await importSpeechCadence();
  const voice = fakeVoice();
  let now = 0;
  const cadence = mod.createSpeechCadence({ voice: voice.door, now: () => now });
  voice.setLatency(200);
  voice.setTimeline([
    {
      text: 'aaaaaaaaaaaa',
      startMs: 0,
      endMs: 5000,
      pieces: [{ text: 'aaaaaaaaaaaa', kind: 'fragment', startMs: 0, endMs: 5000 }],
    },
  ]);
  voice.speak();
  voice.setLevel(0);
  for (now = 0; now < 1000; now += 16) cadence.sample(0.016);
  // The audio graph gets loud at 1000 ms; the listener hears it 200 ms later.
  voice.setLevel(0.5);
  const heard = [];
  for (; now < 1400; now += 16) heard.push([now, cadence.sample(0.016).level]);
  for (const [t, level] of heard) {
    if (t < 1190) assert.equal(level, 0, `still silent for the listener at ${t}ms`);
    if (t >= 1216) assert.ok(level > 0.5, `heard at ${t}ms: ${level}`);
  }
  // Loudness alone follows the same delay.
  voice.setTimeline([]);
  voice.setLevel(0);
  const quietFrom = now;
  for (; now < quietFrom + 400; now += 16) {
    const level = cadence.sample(0.016).level;
    if (now < quietFrom + 190) assert.ok(level > 0.5, `still loud for the listener at ${now - quietFrom}ms after`);
    if (now >= quietFrom + 216) assert.equal(level, 0, `quiet at ${now - quietFrom}ms after`);
  }
});

test('end reasons are taken from every playback change, not the frame-time state', async () => {
  const mod = await importSpeechCadence();
  const open = async (voice, cadence, clock) => {
    voice.setTimeline([]);
    voice.setLevel(0.4);
    voice.speak();
    for (let i = 0; i < 5; i++) {
      clock.now += 16;
      assert.equal(cadence.sample(0.016).cut, undefined);
    }
  };

  // A newer reply replaces the old one between two frames: the mouth still closes at once.
  {
    const voice = fakeVoice();
    const clock = { now: 0 };
    const cadence = mod.createSpeechCadence({ voice: voice.door, now: () => clock.now });
    await open(voice, cadence, clock);
    voice.end('replaced');
    voice.put({ status: 'preparing', messageId: 'm2' });
    voice.put({ status: 'speaking', messageId: 'm2' });
    clock.now += 16;
    assert.equal(cadence.sample(0.016).cut, true, 'replaced between frames is a cut');
    clock.now += 16;
    const next = cadence.sample(0.016);
    assert.equal(next.cut, undefined);
    assert.equal(next.speaking, true, 'the new reply is spoken');
    cadence.dispose();
  }

  // Speech finishes and the next reply starts preparing between two frames: the mouth eases.
  {
    const voice = fakeVoice();
    const clock = { now: 0 };
    const cadence = mod.createSpeechCadence({ voice: voice.door, now: () => clock.now });
    await open(voice, cadence, clock);
    voice.end('finished');
    voice.put({ status: 'preparing', messageId: 'm2' });
    clock.now += 16;
    const sample = cadence.sample(0.016);
    assert.equal(sample.speaking, false);
    assert.equal(sample.cut, undefined, 'finished then preparing is not a cut');
    cadence.dispose();
  }

  // After dispose the cadence stops listening.
  {
    const voice = fakeVoice();
    let calls = 0;
    const listen = voice.door.playback.listen;
    voice.door.playback.listen = (cb) => {
      const off = listen(cb);
      return () => {
        calls++;
        off();
      };
    };
    const cadence = mod.createSpeechCadence({ voice: voice.door, now: () => 0 });
    cadence.dispose();
    assert.equal(calls, 1, 'unsubscribed on dispose');
  }
});

test('vowel shapes open in the order of human vowel height; lips meet on m, b and p', async () => {
  const mod = await importSpeechCadence();
  // Strength of the open shapes, weighted by how far each VRM shape opens a VRoid mouth at full weight.
  const aperture = (w) => w.aa * 1 + w.oh * 0.96 + w.ee * 0.67 + w.ih * 0.18 + w.ou * 0.37;
  const at = (vowel) => aperture(mod.shapeVisemes(vowel, 1));
  assert.ok(at('aa') > at('oh') && at('oh') > at('ee') && at('ee') > at('ih') && at('ih') >= at('ou'), 'a > o > e > i >= u');
  assert.ok(at('ih') > 0.3, `"i" visibly parts the lips: ${at('ih')}`);
  assert.equal(aperture(mod.shapeVisemes(null, 1)), 0);
  for (const word of ['map', 'bob', 'pump']) {
    const steps = mod.buildTimeline(word);
    const closed = steps.filter((s) => s.vowel === null && s.open === 0).length;
    assert.ok(closed >= [...word].filter((c) => 'bmp'.includes(c)).length, `${word}: closed lips on every m/b/p`);
  }
  // Ordinary consonants keep the jaw open enough to read as speech, not a mumble.
  const t = mod.buildTimeline('tat').find((s) => s.vowel === 'aa' && s.open < 0.9);
  assert.ok(t && t.open >= 0.35, `"t" keeps the mouth open: ${t?.open}`);
});
