import test from 'node:test';
import assert from 'node:assert/strict';
import { GainEnvelope } from '../apps/desktop/core/hourly-audio.mjs';
import { PcmMixer } from '../apps/desktop/runtime/voice-output.mjs';

test('accelerating recovery preserves its duration and stays continuous when interrupted or disabled', () => {
  const gain = new GainEnvelope(0.2);
  gain.fade(1, 1000, 10000, 'accelerate');
  for (const [time, expected] of [[9900,0.2],[10000,0.2],[10250,0.25],[10500,0.4],[10750,0.65],[11000,1],[12000,1]]) assert.ok(Math.abs(gain.value(time)-expected)<1e-10);
  gain.fade(0.1, 500, 10500); // New speech interrupts the accelerating return.
  assert.ok(Math.abs(gain.value(10500)-0.4)<1e-10);
  assert.ok(Math.abs(gain.value(10750)-0.25)<1e-10);
  gain.fade(1, 0, 10750, 'accelerate'); assert.equal(gain.value(10750),1);
});

test('ordinary speech and title calls both restore actual PCM with increasing gain increments', async t => {
  for (const titleCall of [false,true]) {
    const mixer = new PcmMixer(); t.after(()=>mixer.destroy());
    mixer.mediaVolume=1; mixer.ducking=0.2; mixer.titleCallDucking=0.8; mixer.duckFadeInMs=1000;
    const media=Buffer.alloc(3840*25); for(let i=0;i<media.length;i+=2)media.writeInt16LE(10000,i); mixer.addMedia(media);
    const speech=mixer.addSpeech(Buffer.alloc(3840),1,undefined,0,titleCall);
    const start=titleCall?8000:2000;
    assert.equal(mixer.takeFrame(10000).readInt16LE(0),start); await speech;
    const actual=[0,250,500,750,1000].map(offset=>mixer.takeFrame(10020+offset).readInt16LE(0));
    const expected=titleCall?[8000,8125,8500,9125,10000]:[2000,2500,4000,6500,10000];
    assert.deepEqual(actual,expected);
    const increments=actual.slice(1).map((value,i)=>value-actual[i]);
    assert.ok(increments.every((value,i)=>!i||value>increments[i-1]));
    assert.equal(mixer.backgroundGain.value(11020),1);
  }
});
