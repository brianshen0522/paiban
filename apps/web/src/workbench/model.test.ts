import { type Cue, SyncCore } from '@paiban/shared';
import { describe, expect, it } from 'vitest';
import { type KeyInput, keyAction } from './keys';
import {
  applyAlignment,
  deleteLines,
  editLine,
  emptyHistory,
  merge,
  nextCheckpoint,
  placeAnchor,
  record,
  redo,
  resetDoc,
  segRange,
  setOffset,
  setRate,
  setText,
  shortTc,
  signed,
  snap,
  split,
  timingDiffers,
  undo,
} from './model';

const cues: Cue[] = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  start: 2 + i * 4,
  end: 4 + i * 4,
  text: `line ${i + 1}`,
}));

const doc = () => ({ ...SyncCore.identityDoc(), checkpoints: SyncCore.pickCheckpoints(cues, 4) });

describe('workbench document', () => {
  it('moves one segment and re-opens only its checkpoints', () => {
    const d0 = split({ ...doc(), checkpoints: doc().checkpoints.map((c) => ({ ...c, status: 'ok' as const })) }, 10);
    if (!d0.ok) throw new Error('split failed');
    const d1 = setOffset(d0.doc, cues.length, 1, -2.3456);
    expect(d1.segments[1]?.offset).toBe(-2.346);
    expect(d1.segments[0]?.offset).toBe(0);
    for (const c of d1.checkpoints) expect(c.status).toBe(c.cue >= 10 ? 'todo' : 'ok');
    expect(segRange(d1, cues.length, 1)).toEqual([10, 20]);
    // the input is untouched (undo snapshots rely on it)
    expect(d0.doc.segments[1]?.offset).toBe(0);
  });

  it('refuses to split at the first line or at an existing start', () => {
    expect(split(doc(), 0)).toEqual({ ok: false, reason: 'first' });
    const d = split(doc(), 5);
    if (!d.ok) throw new Error('split failed');
    expect(split(d.doc, 5)).toEqual({ ok: false, reason: 'already' });
    expect(merge(d.doc, 1).segments).toHaveLength(1);
  });

  it('keeps the selected line in place when the speed changes', () => {
    const d = setOffset(doc(), cues.length, 0, 1);
    const before = SyncCore.applyDoc(cues, d)[7]?.start;
    const after = SyncCore.applyDoc(cues, setRate(d, cues, 0, 7, 25 / 23.976))[7]?.start;
    expect(after).toBeCloseTo(before ?? 0, 2);
  });

  it('fits speed and offset from two anchors', () => {
    const scale = 25 / 23.976;
    const a = placeAnchor(doc(), cues, 1, (cues[1]?.start ?? 0) * scale - 0.8);
    expect(a.count).toBe(1);
    const b = placeAnchor(a.doc, cues, 18, (cues[18]?.start ?? 0) * scale - 0.8);
    expect(b.count).toBe(2);
    expect(b.scale).toBeCloseTo(scale, 6);
    expect(b.offset).toBeCloseTo(-0.8, 2);
    // the same line again replaces its anchor
    expect(placeAnchor(b.doc, cues, 18, 80).doc.anchors).toHaveLength(2);
  });

  it('applies an alignment: segments replaced, anchors cleared, checkpoints re-opened, edits kept', () => {
    const edited = setText(placeAnchor(doc(), cues, 3, 20).doc, cues, 2, 'changed');
    const d = applyAlignment(
      { ...edited, checkpoints: edited.checkpoints.map((c) => ({ ...c, status: 'ok' as const })) },
      [{ from: 0, scale: 1, offset: -2.3604 }],
    );
    expect(d.segments).toEqual([{ from: 0, scale: 1, offset: -2.36 }]);
    expect(d.anchors).toEqual([]);
    expect(d.checkpoints.every((c) => c.status === 'todo')).toBe(true);
    expect(d.edits['3']?.text).toBe('changed');
  });

  it('stores line edits as deltas and drops edits that undo themselves', () => {
    let d = editLine(doc(), cues, 4, 's+', 0);
    expect(d.edits['5']).toEqual({ dStart: 0.05 });
    d = editLine(d, cues, 4, 's-', 0);
    expect(d.edits['5']).toBeUndefined();
    d = editLine(d, cues, 4, 'e=', 30);
    expect(d.edits['5']?.dEnd).toBeCloseTo(30 - (cues[4]?.end ?? 0), 3);
    d = setText(setText(d, cues, 4, 'x'), cues, 4, 'line 5');
    expect(d.edits['5']?.text).toBeUndefined();
    d = editLine(d, cues, 4, 'del', 0);
    expect(SyncCore.applyDoc(cues, d)[4]?.deleted).toBe(true);
  });

  it('deletes the lines another subtitle found nothing for, by cue id, in one step', () => {
    const d = deleteLines(editLine(doc(), cues, 0, 'del', 0), cues, [cues[0]?.id ?? 0, cues[2]?.id ?? 0, 999]);
    const m = SyncCore.applyDoc(cues, d);
    expect(m.filter((c) => c.deleted).map((c) => c.id)).toEqual([cues[0]?.id, cues[2]?.id]);
  });

  it('tells timing changes from checkpoint marks', () => {
    const a = doc();
    const b = { ...a, checkpoints: a.checkpoints.map((c) => ({ ...c, status: 'ok' as const })) };
    expect(timingDiffers(a, b)).toBe(false);
    expect(timingDiffers(a, setOffset(a, cues.length, 0, 0.05))).toBe(true);
    expect(timingDiffers(a, setText(a, cues, 0, 'other'))).toBe(true);
  });

  it('walks to the next checkpoint that has not passed', () => {
    const d = doc();
    expect(nextCheckpoint(d, -1)).toBe(0);
    const marked = {
      ...d,
      checkpoints: d.checkpoints.map((c, j) => ({ ...c, status: j === 1 ? 'todo' : 'ok' }) as const),
    };
    expect(nextCheckpoint(marked, 2)).toBe(1);
    expect(nextCheckpoint({ ...d, checkpoints: d.checkpoints.map((c) => ({ ...c, status: 'ok' as const })) }, 0)).toBe(
      -1,
    );
  });

  it('snaps to speech only when it moves', () => {
    // speech exactly where the lines are, shifted 0.4 s later
    const speech = SyncCore.makeSpeech({
      hz: 100,
      frames: 10000,
      segments: cues.map(
        (c) => [Math.round((c.start + 0.4) * 100), Math.round((c.end + 0.4) * 100)] as [number, number],
      ),
    });
    const r = snap(doc(), cues, speech, 0);
    expect(r?.doc.segments[0]?.offset).toBeCloseTo(0.4, 2);
    expect(r && snap(r.doc, cues, speech, 0)).toBeNull();
  });

  it('keeps 100 undo steps and redoes what was undone', () => {
    let h = emptyHistory();
    let cur = doc();
    for (let i = 0; i < 120; i++) {
      h = record(h, cur);
      cur = setOffset(cur, cues.length, 0, i + 1);
    }
    expect(h.past).toHaveLength(100);
    const u = undo(h, cur);
    expect(u?.doc.segments[0]?.offset).toBe(119);
    const r = u && redo(u.history, u.doc);
    expect(r?.doc.segments[0]?.offset).toBe(120);
    expect(undo(emptyHistory(), cur)).toBeNull();
  });

  it('resets to the original with fresh checkpoints', () => {
    const d = resetDoc(cues, 8);
    expect(d.segments).toEqual([{ from: 0, scale: 1, offset: 0 }]);
    expect(d.checkpoints).toHaveLength(8);
  });
});

describe('numbers', () => {
  it('writes offsets with a real minus sign and list times as minutes', () => {
    expect(signed(-2.36)).toBe('−2.36');
    expect(signed(13.24)).toBe('+13.24');
    expect(signed(-0.001)).toBe('+0.00');
    expect(signed(-2.36, 3)).toBe('−2.360');
    expect(shortTc(83.456)).toBe('01:23.456');
    expect(shortTc(6730)).toBe('112:10.000');
  });
});

describe('shortcuts', () => {
  const k = (key: string, more: Partial<KeyInput> = {}): KeyInput => ({
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    target: 'other',
    ...more,
  });
  it('map keys to actions', () => {
    expect(keyAction(k(' '))).toEqual({ kind: 'toggle-play' });
    expect(keyAction(k('ArrowLeft', { shiftKey: true }))).toEqual({ kind: 'seek', by: -5 });
    expect(keyAction(k(','))).toEqual({ kind: 'nudge', by: -0.05 });
    expect(keyAction(k('>', { shiftKey: true }))).toEqual({ kind: 'nudge', by: 0.5 });
    expect(keyAction(k('Z', { shiftKey: true }))).toEqual({ kind: 'redo' });
    expect(keyAction(k('a'))).toEqual({ kind: 'auto' });
    expect(keyAction(k('Enter'))).toEqual({ kind: 'anchor' });
  });
  it('stay out of the way of fields, buttons and modifier keys', () => {
    expect(keyAction(k('a', { target: 'field' }))).toBeNull();
    expect(keyAction(k(' ', { target: 'button' }))).toBeNull();
    expect(keyAction(k('Enter', { target: 'button' }))).toBeNull();
    expect(keyAction(k('n', { target: 'button' }))).toEqual({ kind: 'next-checkpoint' });
    expect(keyAction(k('z', { ctrlKey: true }))).toBeNull();
    expect(keyAction(k('o', { repeat: true }))).toBeNull();
  });
});
