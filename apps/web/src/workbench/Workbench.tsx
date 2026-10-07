import {
  type AlignResult,
  type MediaStatus,
  type SpeechData,
  type Subtitle,
  type SubtitleDetail,
  SyncCore,
  type SyncDoc,
  type Workspace,
} from '@paiban/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { Banner, Chip, Skeleton } from '../components/Bits';
import { useToast } from '../components/Toasts';
import { t } from '../copy/zh-TW';
import { api, asFailure, type Conflict, conflictOf, fieldCodes, get, getBytes, post } from '../lib/api';
import { RECONNECTED, SUBTITLE_EVENT, type SubtitleEvent } from '../lib/events';
import { keys, useMe, useSubtitle } from '../lib/queries';
import { langName } from '../pages/workspace/SubtitlesTab';
import { CueList, type ListMode } from './CueList';
import { drawOverview, drawTimeline, LANE_H, LANE_Y, type Palette, readPalette, type Scene, type View } from './draw';
import { keyAction, targetKind } from './keys';
import {
  applyAlignment,
  deleteLines,
  displayText,
  editLine,
  emptyHistory,
  type History,
  type LineOp,
  markCheckpoint,
  merge as mergeSeg,
  moveLine,
  nextCheckpoint,
  pct,
  placeAnchor,
  plainOffset,
  ratePivot,
  rateText,
  record,
  redo as redoStep,
  resetDoc,
  sameDoc,
  scoreClass,
  segOf,
  segRange,
  setOffset,
  setRate,
  setText,
  shortTc,
  signed,
  snap as snapSeg,
  split as splitSeg,
  timecode,
  timingDiffers,
  undo as undoStep,
} from './model';

type Speech = SyncCore.Speech;
type SourceKind = MediaStatus['sources'][number]['kind'];
type Msg = { text: string; actions?: { label: string; run: () => void }[] };
type SaveState = 'saved' | 'saving' | 'dirty' | 'failed' | 'conflict';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
/** The tools under the video, one at a time, in the order the steps use them. */
const DOCK_TABS = ['auto', 'checkpoints', 'offset', 'anchors', 'compare'] as const;
type DockTab = (typeof DOCK_TABS)[number];
const SAVE_DELAY = 1500;
const SAVE_RETRY = 5000;

/** docs/09-sync-workbench.md, in full. Loads the subtitle, then hands over to the bench. */
export function Workbench({ ws, subtitle }: { ws: Workspace; subtitle: Subtitle }) {
  const detail = useSubtitle(subtitle.id);
  if (detail.isError)
    return (
      <Banner tone="bad">
        <span>{t.syncTab.loadError}</span>
        <button type="button" onClick={() => detail.refetch()}>
          {t.common.retry}
        </button>
      </Banner>
    );
  if (!detail.data) return <Skeleton lines={8} />;
  return <Bench ws={ws} detail={detail.data} />;
}

/** "*bold*" segments from the message templates. */
function Rich({ text }: { text: string }) {
  return (
    <span>
      {text.split('*').map((part, i) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed sentence
        i % 2 ? <b key={i}>{part}</b> : <span key={i}>{part}</span>,
      )}
    </span>
  );
}

/** A stable function that always runs the latest closure (for listeners attached once). */
function useLatest<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...a: A) => ref.current(...a), []);
}

function Bench({ ws, detail }: { ws: Workspace; detail: SubtitleDetail }) {
  const me = useMe().data;
  const qc = useQueryClient();
  const toast = useToast();
  const sub = detail.subtitle;
  const torrent = ws.item.torrent;
  const media = torrent.media;
  const cues = detail.cues;
  const n = cues.length;

  /* ---------------------------------------------------------------- the document and its history */

  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const docRef = useRef<SyncDoc>(detail.doc);
  const historyRef = useRef<History>(emptyHistory());
  const savedRef = useRef<{ doc: SyncDoc; rev: number }>({ doc: detail.doc, rev: sub.rev });
  const reasonRef = useRef<'auto-align' | 'reset' | null>(null);
  const confirmedDocRef = useRef<SyncDoc | null>(sub.status === 'confirmed' ? detail.doc : null);
  // What the server last said; shown as a draft at once while the timing differs from what was confirmed.
  const [serverStatus, setStatus] = useState(sub.status);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const conflictRef = useRef(false);
  const [removed, setRemoved] = useState(false);
  const removedRef = useRef(false);
  const doc = docRef.current;
  const status =
    serverStatus === 'confirmed' && (!confirmedDocRef.current || !timingDiffers(confirmedDocRef.current, doc))
      ? 'confirmed'
      : 'draft';

  const [msg, setMsg] = useState<Msg>({ text: t.bench.msg.ready });
  const say = useCallback(
    (text: string, actions?: Msg['actions']) => setMsg({ text, ...(actions ? { actions } : {}) }),
    [],
  );

  const [sel, setSel] = useState(0);
  const [reveal, setReveal] = useState(0);
  const [cpCur, setCpCur] = useState(-1);
  const [mode, setMode] = useState<ListMode>('sync');
  const [showOrig, setShowOrig] = useState(false);
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [allowSplit, setAllowSplit] = useState(true);
  // The tool shown under the video (Brian, 2026-10-06): listening and adjusting without scrolling away from it.
  const [dock, setDock] = useState<DockTab>(() =>
    sub.status === 'confirmed' || detail.doc.segments.some((x) => x.offset !== 0 || x.scale !== 1)
      ? 'checkpoints'
      : 'auto',
  );
  const [aligning, setAligning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [askConfirm, setAskConfirm] = useState<number | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playingCue, setPlayingCue] = useState(-1);

  /* ---------------------------------------------------------------- saving (docs/09, "儲存") */

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const dirty = useCallback(() => !sameDoc(docRef.current, savedRef.current.doc), []);

  const saveOnce = useLatest(async (): Promise<boolean> => {
    if (conflictRef.current || removedRef.current) return false;
    const sent = docRef.current;
    if (!dirty()) {
      setSaveState('saved');
      return true;
    }
    setSaveState('saving');
    const reason = reasonRef.current;
    try {
      const r = await api<{ rev: number; status: 'draft' | 'confirmed'; score: number | null }>(
        'PUT',
        `/api/subtitles/${sub.id}/doc`,
        { rev: savedRef.current.rev, doc: sent, ...(reason ? { reason } : {}) },
      );
      if (reasonRef.current === reason) reasonRef.current = null;
      savedRef.current = { doc: sent, rev: r.rev };
      setStatus(r.status);
      if (r.status === 'draft') confirmedDocRef.current = null;
      setSaveState(dirty() ? 'dirty' : 'saved');
      void qc.invalidateQueries({ queryKey: keys.workspace(torrent.id) });
      return true;
    } catch (e) {
      const c = conflictOf(e);
      const f = asFailure(e);
      if (c) {
        conflictRef.current = true;
        setConflict(c);
        setSaveState('conflict');
      } else if (f.code === 'NOT_FOUND' || f.code === 'NOT_HOLDER') {
        removedRef.current = true;
        setRemoved(true);
        say(t.bench.msg.removedElsewhere);
      } else {
        setSaveState('failed');
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void save(), SAVE_RETRY);
      }
      return false;
    }
  });

  /** Save now, waiting for one already on its way; keeps going until nothing is left unsaved. */
  const save = useLatest(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    for (let tries = 0; tries < 5; tries++) {
      if (inFlight.current) await inFlight.current;
      if (!dirty()) {
        if (!conflictRef.current) setSaveState('saved');
        return !conflictRef.current && !removedRef.current;
      }
      const p = saveOnce();
      inFlight.current = p;
      const ok = await p;
      inFlight.current = null;
      if (!ok) return false;
    }
    return !dirty();
  });

  const scheduleSave = useLatest(() => {
    if (conflictRef.current || removedRef.current) return;
    clearTimeout(timer.current);
    if (!dirty()) {
      setSaveState('saved');
      return;
    }
    setSaveState('dirty');
    timer.current = setTimeout(() => void save(), SAVE_DELAY);
  });

  /** Every change goes through here: undo step, draft status, autosave. */
  const commit = useLatest((next: SyncDoc, opts: { record?: boolean; reason?: 'auto-align' | 'reset' } = {}) => {
    if (opts.record !== false) historyRef.current = record(historyRef.current, docRef.current);
    docRef.current = next;
    if (opts.reason) reasonRef.current = opts.reason;
    scheduleSave();
    rerender();
  });

  // Leaving the page or switching subtitles: send what is unsaved; warn when the tab is closed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once for this subtitle (the bench is keyed by it)
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty() && !removedRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      clearTimeout(timer.current);
      if (dirty() && !conflictRef.current && !removedRef.current) {
        const reason = reasonRef.current;
        void api(
          'PUT',
          `/api/subtitles/${sub.id}/doc`,
          { rev: savedRef.current.rev, doc: docRef.current, ...(reason ? { reason } : {}) },
          { keepalive: true },
        )
          .then(() => qc.invalidateQueries({ queryKey: keys.workspace(torrent.id) }))
          .catch(() => undefined);
      }
    };
  }, []);

  // Someone else saved: reload when nothing here is unsaved; otherwise the next save reports the conflict.
  const reload = useLatest(async (by: string | null) => {
    try {
      const fresh = await get<SubtitleDetail>(`/api/subtitles/${sub.id}`);
      if (dirty() || inFlight.current) return;
      docRef.current = fresh.doc;
      savedRef.current = { doc: fresh.doc, rev: fresh.subtitle.rev };
      setStatus(fresh.subtitle.status);
      confirmedDocRef.current = fresh.subtitle.status === 'confirmed' ? fresh.doc : null;
      qc.setQueryData(keys.subtitle(sub.id), fresh);
      if (by) say(t.bench.msg.reloaded(by));
      rerender();
    } catch {
      // the next save or event catches up
    }
  });
  useEffect(() => {
    const onEvent = (ev: Event) => {
      const e = (ev as CustomEvent<SubtitleEvent>).detail;
      if (e.subtitleId !== sub.id) return;
      if (e.removed) {
        removedRef.current = true;
        setRemoved(true);
        say(t.bench.msg.removedElsewhere);
        return;
      }
      if (e.rev <= savedRef.current.rev || inFlight.current || dirty()) return;
      void reload(e.by?.displayName ?? t.bench.msg.someone);
    };
    const onReconnect = () => {
      if (!dirty() && !inFlight.current) void reload(null);
    };
    window.addEventListener(SUBTITLE_EVENT, onEvent);
    window.addEventListener(RECONNECTED, onReconnect);
    return () => {
      window.removeEventListener(SUBTITLE_EVENT, onEvent);
      window.removeEventListener(RECONNECTED, onReconnect);
    };
  }, [sub.id, reload, say, dirty]);

  const takeTheirs = useLatest(() => {
    if (!conflict) return;
    historyRef.current = record(historyRef.current, docRef.current);
    docRef.current = conflict.doc;
    savedRef.current = { doc: conflict.doc, rev: conflict.rev };
    conflictRef.current = false;
    setConflict(null);
    setSaveState('saved');
    say(t.bench.msg.tookTheirs);
    void qc.invalidateQueries({ queryKey: keys.workspace(torrent.id) });
    rerender();
  });
  const keepMine = useLatest(async () => {
    if (!conflict) return;
    savedRef.current = { ...savedRef.current, rev: conflict.rev };
    conflictRef.current = false;
    setConflict(null);
    if (await save()) say(t.bench.msg.keptMine);
  });

  /* ---------------------------------------------------------------- analysis data */

  const mediaId = media?.id ?? '';
  const analysisEnded = media?.analysis === 'ready' || media?.analysis === 'failed';
  const peaksQ = useQuery({
    queryKey: keys.peaks(mediaId),
    queryFn: async () => {
      try {
        return new Int8Array(await getBytes(`/api/media/${mediaId}/peaks`));
      } catch (e) {
        if (asFailure(e).status === 404) return null;
        throw e;
      }
    },
    enabled: !!mediaId && analysisEnded,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  const speechQ = useQuery({
    queryKey: keys.speech(mediaId),
    queryFn: async () => {
      try {
        return await get<SpeechData>(`/api/media/${mediaId}/speech`);
      } catch (e) {
        if (asFailure(e).status === 404) return null;
        throw e;
      }
    },
    enabled: !!mediaId && analysisEnded,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  const speech: Speech | null = useMemo(
    () => (speechQ.data ? SyncCore.makeSpeech(speechQ.data) : null),
    [speechQ.data],
  );
  const peaks = peaksQ.data ?? null;

  /* ---------------------------------------------------------------- derived times */

  const mapped = useMemo(() => SyncCore.applyDoc(cues, doc), [cues, doc]);
  const orig = useMemo(() => SyncCore.applyDoc(cues, SyncCore.identityDoc()), [cues]);
  const shown = showOrig ? orig : mapped;
  const scores = useMemo(() => {
    if (!speech) return null;
    const out = new Float32Array(shown.length);
    shown.forEach((c, i) => {
      out[i] = SyncCore.cueScore(speech, c);
    });
    return out;
  }, [shown, speech]);
  const score = useMemo(() => (speech ? SyncCore.totalScore(speech, mapped) : null), [speech, mapped]);
  const scoreOf = (d: SyncDoc) => (speech ? SyncCore.totalScore(speech, SyncCore.applyDoc(cues, d)) : null);

  /* ---------------------------------------------------------------- the second subtitle */

  const others = ws.subtitles.filter((s) => s.id !== sub.id);
  // The subtitle to align by: confirmed ones first, they are the ones known to be right.
  const refChoices = [...others].sort((a, b) => Number(b.status === 'confirmed') - Number(a.status === 'confirmed'));
  const [refId, setRefId] = useState<string | null>(refChoices[0]?.id ?? null);
  const refPicked = refChoices.find((s) => s.id === refId) ?? refChoices[0] ?? null;
  const preferredSecond = others.find((s) => s.language === 'en' && sub.language !== 'en') ?? others[0] ?? null;
  const [secondOn, setSecondOn] = useState(() => !!me?.user.prefs.secondLine && !!preferredSecond);
  const [secondId, setSecondId] = useState<string | null>(preferredSecond?.id ?? null);
  const second = useSubtitle(secondOn && secondId && others.some((s) => s.id === secondId) ? secondId : null);
  const secondCues = useMemo(() => {
    if (!secondOn || !second.data) return null;
    return SyncCore.applyDoc(second.data.cues, second.data.doc)
      .filter((c) => !c.deleted)
      .sort((a, b) => a.start - b.start);
  }, [secondOn, second.data]);
  /** The second subtitle's line at time t, by binary search. */
  const secondAt = useCallback(
    (time: number): string | null => {
      if (!secondCues) return null;
      let lo = 0;
      let hi = secondCues.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((secondCues[mid]?.start ?? 0) <= time) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      for (let k = best; k >= 0 && k > best - 3; k--) {
        const c = secondCues[k];
        if (c && time >= c.start && time < c.end) return c.text;
      }
      return null;
    },
    [secondCues],
  );
  const secondTexts = useMemo(
    () => (secondCues ? mapped.map((c) => secondAt((c.start + c.end) / 2)) : null),
    [secondCues, mapped, secondAt],
  );

  /* ---------------------------------------------------------------- media element (docs/09, "播哪個檔") */

  const videoRef = useRef<HTMLVideoElement>(null);
  const sources = media?.sources ?? [];
  const [kind, setKind] = useState<SourceKind | null>(null);
  const [failedKinds, setFailedKinds] = useState<SourceKind[]>([]);
  const usable = sources.filter((s) => !failedKinds.includes(s.kind));
  const active = usable.find((s) => s.kind === kind) ?? null;
  const firstUsable = usable[0];
  useEffect(() => {
    if (!active && firstUsable) setKind(firstUsable.kind);
  }, [active, firstUsable]);
  const better = active && firstUsable && firstUsable.kind !== active.kind ? firstUsable : null;
  const allFailed = sources.length > 0 && usable.length === 0;
  const resumeAt = useRef(0);
  const onMediaError = () => {
    if (!active) return;
    resumeAt.current = videoRef.current?.currentTime ?? resumeAt.current;
    setFailedKinds((f) => [...f, active.kind]);
    setKind(null);
  };
  const switchTo = (k: SourceKind) => {
    resumeAt.current = videoRef.current?.currentTime ?? 0;
    setKind(k);
  };
  const [mediaDuration, setMediaDuration] = useState(0);
  const lastEnd = mapped.reduce((m, c) => Math.max(m, c.end), 0);
  const duration = Math.max(1, media?.durationSeconds || mediaDuration || lastEnd + 5);

  const clock = () => videoRef.current?.currentTime ?? 0;
  const rangeEnd = useRef<number | null>(null);
  const viewRef = useRef<View>({ t0: 0, dur: duration });
  const dirtyRef = useRef(true);
  if (viewRef.current.dur > duration || viewRef.current.dur <= 0) viewRef.current = { t0: 0, dur: duration };

  const setView = useLatest((centre: number, dur: number) => {
    const d = Math.max(Math.min(8, duration), Math.min(duration, dur));
    viewRef.current = { dur: d, t0: Math.max(0, Math.min(duration - d, centre - d / 2)) };
    dirtyRef.current = true;
  });
  const seek = useLatest((x: number) => {
    const v = videoRef.current;
    const time = Math.max(0, Math.min(duration - 0.05, x));
    if (v && active) v.currentTime = time;
    else resumeAt.current = time;
    dirtyRef.current = true;
  });
  const play = () => {
    const v = videoRef.current;
    if (!v || !active) return;
    if (v.ended) v.currentTime = 0;
    void v.play().catch(() => undefined);
  };
  const togglePlay = useLatest(() => {
    const v = videoRef.current;
    rangeEnd.current = null;
    if (!v || !active) return;
    if (v.paused || v.ended) play();
    else v.pause();
  });
  const playRange = useLatest((a: number, b: number) => {
    rangeEnd.current = b;
    seek(Math.max(0, a));
    play();
  });
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  /* ---------------------------------------------------------------- actions */

  const k = segOf(doc, Math.min(sel, Math.max(0, n - 1)));
  const select = useLatest((i: number, revealIt = false) => {
    const next = Math.max(0, Math.min(n - 1, i));
    setSel(next);
    if (revealIt) setReveal((r) => r + 1);
    dirtyRef.current = true;
  });

  const nudge = useLatest((d: number) => {
    const cur = docRef.current;
    const seg = segOf(cur, sel);
    const next = setOffset(cur, n, seg, (cur.segments[seg]?.offset ?? 0) + d);
    commit(next);
    say(t.bench.msg.nudge(d < 0, Math.round(Math.abs(d) * 1000), signed(next.segments[seg]?.offset ?? 0)));
  });

  /** Aligns by the film's sound, or, given another subtitle of the film, by that one (docs/08). */
  const auto = useLatest(async (referenceId?: string) => {
    if (aligning) return;
    if (!referenceId && !speech) {
      say(t.bench.msg.alignNoSpeech);
      return;
    }
    setAligning(true);
    try {
      const r = await post<AlignResult>(
        `/api/subtitles/${sub.id}/auto-align`,
        referenceId ? { allowSplit, referenceId } : { allowSplit },
      );
      const before = scoreOf(docRef.current);
      const next = applyAlignment(docRef.current, r.segments);
      commit(next, { reason: 'auto-align' });
      setCpCur(-1);
      setDock('checkpoints');
      const after = scoreOf(next);
      const multi = next.segments.length > 1;
      const parts = next.segments
        .map((s, j) => {
          const [a, b] = segRange(next, n, j);
          return t.bench.msg.autoPart(
            multi ? t.bench.summary.lines(a + 1, b) : '',
            signed(s.offset),
            s.scale !== 1 ? rateText(s.scale) : null,
          );
        })
        .join('；');
      const method: string = r.method;
      let text =
        before != null && after != null
          ? t.bench.msg.autoDone(parts, pct(before), pct(after))
          : t.bench.msg.autoDoneNoScore(parts);
      if (method) text += t.bench.msg.method(t.bench.methods[method] ?? method);
      if (r.agree === false) text += t.bench.msg.disagree;
      // What speech recognition contributed; absent on older servers, null when the film has none.
      const heard = r.heard;
      if (heard) {
        const lang = t.media.asrLangs[heard.language] ?? heard.language;
        text +=
          heard.pairs > 0
            ? t.bench.msg.heard(lang, heard.pairs, heard.support, heard.via === 'llm')
            : t.bench.msg.heardNothing(lang);
        if (heard.llmError) text += t.bench.msg.llmFailed(t.bench.msg.llmErrors[heard.llmError] ?? heard.llmError);
      }
      const ref = r.reference;
      if (ref) {
        const name = langName(ws.subtitles.find((x) => x.id === ref.subtitleId)?.language ?? '');
        text += ref.via === 'text' ? t.bench.msg.refPaired(name, ref.pairs, ref.support) : t.bench.msg.refTiming(name);
        // Followed either way; but if the reference itself is off from the film's speech, say so.
        if (ref.offBy != null) text += t.bench.msg.refOff(name, ref.offBy.toFixed(1));
      }
      // Lines the reference has nothing for: offered, never deleted without the person saying so.
      const extra = r.extraLines ?? [];
      if (extra.length) {
        const nums = extra.map((id) => cues.findIndex((c) => c.id === id) + 1).filter((x) => x > 0);
        text += t.bench.msg.refExtra(nums.join('、'));
        say(text, [
          {
            label: t.bench.msg.refDelete(nums.length),
            run: () => {
              commit(deleteLines(docRef.current, cues, extra));
              say(t.bench.msg.refDeleted(nums.length));
            },
          },
        ]);
      } else say(text);
    } catch (e) {
      const f = asFailure(e);
      say(
        f.code === 'MEDIA_NOT_READY'
          ? t.bench.msg.alignNoSpeech
          : f.code === 'VALIDATION' && referenceId
            ? t.bench.msg.refInvalid
            : f.code === 'RATE_LIMITED'
              ? t.bench.msg.alignTooOften(
                  f.details && 'retryAfterSeconds' in f.details ? Math.ceil(f.details.retryAfterSeconds / 60) : 1,
                )
              : f.code === 'NETWORK'
                ? t.common.offline
                : t.bench.msg.alignFailed,
      );
    } finally {
      setAligning(false);
    }
  });

  const snap = useLatest(() => {
    if (!speech) return;
    const cur = docRef.current;
    const seg = segOf(cur, sel);
    const r = snapSeg(cur, cues, speech, seg);
    if (!r) {
      say(t.bench.msg.snapNone);
      return;
    }
    commit(r.doc);
    say(
      t.bench.msg.snapped(r.delta < 0, Math.round(Math.abs(r.delta) * 1000), signed(r.doc.segments[seg]?.offset ?? 0)),
    );
  });

  const anchor = useLatest(() => {
    if (!n) return;
    const at = clock();
    const r = placeAnchor(docRef.current, cues, sel, at);
    commit(r.doc);
    say(t.bench.msg.anchored(sel + 1, shortTc(at), signed(r.offset), r.count >= 2 ? rateText(r.scale) : null, r.count));
  });

  const split = useLatest(() => {
    const r = splitSeg(docRef.current, sel);
    if (!r.ok) {
      say(r.reason === 'first' ? t.bench.msg.splitFirst : t.bench.msg.splitAlready(sel + 1));
      return;
    }
    commit(r.doc);
    say(t.bench.msg.split(sel + 1));
  });
  const merge = useLatest(() => {
    const seg = segOf(docRef.current, sel);
    if (seg === 0) return;
    commit(mergeSeg(docRef.current, seg));
    say(t.bench.msg.merged);
  });

  const cpGo = useLatest((j: number) => {
    const cp = docRef.current.checkpoints[j];
    if (!cp) return;
    setCpCur(j);
    setDock('checkpoints');
    select(cp.cue, true);
    const m = mapped[cp.cue];
    if (!m) return;
    if (viewRef.current.dur < duration) setView(m.start, viewRef.current.dur);
    playRange(m.start - 1.5, m.end + 0.5);
    say(t.bench.msg.cpListen(j + 1, docRef.current.checkpoints.length, cp.cue + 1));
  });
  const cpNext = useLatest(() => {
    const j = nextCheckpoint(docRef.current, cpCur);
    if (j < 0) {
      say(docRef.current.checkpoints.length ? t.bench.msg.cpAllOk : t.bench.checkpoints.none);
      return;
    }
    cpGo(j);
  });
  const cpMark = useLatest((s: 'ok' | 'bad') => {
    if (cpCur < 0) {
      say(t.bench.msg.cpFirst);
      return;
    }
    const next = markCheckpoint(docRef.current, cpCur, s);
    commit(next);
    if (s === 'bad') {
      say(t.bench.msg.cpBad((next.checkpoints[cpCur]?.cue ?? 0) + 1));
      return;
    }
    if (next.checkpoints.every((c) => c.status === 'ok')) say(t.bench.msg.cpAllOk);
    else cpNext();
  });

  const undo = useLatest(() => {
    const r = undoStep(historyRef.current, docRef.current);
    if (!r) {
      say(t.bench.msg.noUndo);
      return;
    }
    historyRef.current = r.history;
    commit(r.doc, { record: false });
    say(t.bench.msg.undone);
  });
  const redo = useLatest(() => {
    const r = redoStep(historyRef.current, docRef.current);
    if (!r) {
      say(t.bench.msg.noRedo);
      return;
    }
    historyRef.current = r.history;
    commit(r.doc, { record: false });
    say(t.bench.msg.redone);
  });
  const reset = useLatest(() => {
    commit(resetDoc(cues, me?.limits.checkpointCount ?? 8), { reason: 'reset' });
    setCpCur(-1);
    say(t.bench.msg.reset);
  });

  const setOrig = useLatest((on: boolean) => {
    setShowOrig(on);
    dirtyRef.current = true;
  });

  const changeMode = (m: ListMode) => {
    setMode(m);
    setReveal((r) => r + 1);
    say(m === 'edit' ? t.bench.msg.modeEdit : t.bench.msg.modeSync);
  };

  const onEdit = useLatest((i: number, op: LineOp) => {
    const next = editLine(docRef.current, cues, i, op, clock());
    commit(next);
    const m = SyncCore.applyDoc(cues, next)[i];
    if (!m) return;
    say(
      op === 'del'
        ? m.deleted
          ? t.bench.msg.lineDeleted(i + 1)
          : t.bench.msg.lineRestored(i + 1)
        : t.bench.msg.lineTimed(i + 1, shortTc(m.start), shortTc(m.end)),
    );
  });
  // Typing is one undo step from the first keystroke until the field loses focus.
  const typing = useRef(false);
  const onTextFocus = useLatest(() => {
    typing.current = false;
  });
  const onText = useLatest((i: number, text: string) => {
    commit(setText(docRef.current, cues, i, text), { record: !typing.current });
    typing.current = true;
  });

  const [offsetText, setOffsetText] = useState(plainOffset(doc.segments[k]?.offset ?? 0));
  const offsetFocused = useRef(false);
  const curOffset = doc.segments[k]?.offset ?? 0;
  useEffect(() => {
    if (!offsetFocused.current) setOffsetText(plainOffset(curOffset));
  }, [curOffset]);
  const applyOffsetText = () => {
    const v = Number(offsetText.replace('−', '-').trim());
    if (offsetText.trim() === '' || !Number.isFinite(v)) {
      say(t.bench.msg.offsetNaN);
      setOffsetText(plainOffset(curOffset));
      return;
    }
    if (Math.abs(v - curOffset) < 0.0005) return;
    const next = setOffset(docRef.current, n, k, v);
    commit(next);
    say(t.bench.msg.offsetSet(signed(next.segments[k]?.offset ?? 0)));
  };

  const changeRate = (id: string) => {
    const r = SyncCore.RATES.find((x) => x.id === id);
    if (!r) return;
    const cur = docRef.current;
    const piv = ratePivot(cur, n, k, sel);
    commit(setRate(cur, cues, k, sel, r.scale));
    say(t.bench.msg.rateSet(rateText(r.scale), piv + 1));
  };

  const confirm = useLatest(async (force = false) => {
    const left = docRef.current.checkpoints.filter((c) => c.status !== 'ok').length;
    // Asked right under the button: the message bar is below the timeline, out of sight from here.
    if (left && !force) {
      setAskConfirm(left);
      return;
    }
    setAskConfirm(null);
    setConfirmError(null);
    setConfirming(true);
    try {
      if (!(await save())) {
        // The edits did not reach the server, so there is nothing settled to confirm yet.
        setConfirmError(t.bench.msg.confirmNotSaved);
        return;
      }
      const send = () =>
        post<Subtitle>(`/api/subtitles/${sub.id}/confirm`, {
          rev: savedRef.current.rev,
          ...(left ? { force: true } : {}),
        });
      // The server restarting (an update) answers for a few seconds with nothing: once more, a little later.
      const s = await send().catch(async (e) => {
        if (asFailure(e).code !== 'NETWORK') throw e;
        await new Promise((r) => setTimeout(r, 4000));
        return send();
      });
      savedRef.current = { ...savedRef.current, rev: s.rev };
      setStatus('confirmed');
      confirmedDocRef.current = docRef.current;
      say(t.bench.msg.confirmed);
      toast(t.bench.msg.confirmedToast(langName(s.language)));
      void qc.invalidateQueries({ queryKey: keys.workspace(torrent.id) });
      void qc.invalidateQueries({ queryKey: keys.library });
      requestAnimationFrame(() =>
        document.getElementById('bench-summary')?.scrollIntoView({
          block: 'nearest',
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        }),
      );
    } catch (e) {
      const c = conflictOf(e);
      if (c) {
        conflictRef.current = true;
        setConflict(c);
        setSaveState('conflict');
      } else {
        const f = asFailure(e);
        // Checkpoints the server still has as unheard (a mark that had not reached it): ask, as before pressing.
        const pending = f.code === 'VALIDATION' && fieldCodes(f).force === 'CHECKPOINTS_PENDING';
        if (pending) {
          setAskConfirm(docRef.current.checkpoints.filter((c) => c.status !== 'ok').length || 1);
          return;
        }
        const text =
          f.code === 'NETWORK'
            ? t.bench.msg.confirmUnreachable
            : f.code === 'NOT_HOLDER' || f.code === 'NOT_FOUND'
              ? t.bench.msg.removedElsewhere
              : t.bench.msg.confirmFailedCode(f.code, f.status);
        say(text);
        setConfirmError(text);
      }
    } finally {
      setConfirming(false);
    }
  });

  // A conflict is a decision: it stays in the message bar until one of the two is chosen.
  useEffect(() => {
    if (!conflict) return;
    say(t.bench.msg.conflict(conflict.updatedBy?.displayName ?? t.bench.msg.someone), [
      { label: t.bench.msg.takeTheirs, run: () => takeTheirs() },
      { label: t.bench.msg.keepMine, run: () => void keepMine() },
    ]);
  }, [conflict, say, takeTheirs, keepMine]);

  /* ---------------------------------------------------------------- keyboard (docs/09, "快捷鍵") */

  const onKey = useLatest((e: KeyboardEvent) => {
    const a = keyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      repeat: e.repeat,
      target: targetKind(e.target),
    });
    if (!a) return;
    e.preventDefault();
    switch (a.kind) {
      case 'toggle-play':
        return togglePlay();
      case 'seek':
        rangeEnd.current = null;
        return seek(clock() + a.by);
      case 'select':
        return select(sel + a.by, true);
      case 'nudge':
        return nudge(a.by);
      case 'anchor':
        return anchor();
      case 'auto':
        return void auto();
      case 'next-checkpoint':
        return cpNext();
      case 'original':
        return setOrig(true);
      case 'undo':
        return undo();
      case 'redo':
        return redo();
    }
  });
  useEffect(() => {
    const down = (e: KeyboardEvent) => onKey(e);
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'o') setOrig(false);
    };
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    return () => {
      document.removeEventListener('keydown', down);
      document.removeEventListener('keyup', up);
    };
  }, [onKey, setOrig]);

  /* ---------------------------------------------------------------- drawing loop */

  const tlRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const subRef = useRef<HTMLSpanElement>(null);
  const sub2Ref = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<HTMLOutputElement>(null);
  const paletteRef = useRef<Palette | null>(null);
  const sceneRef = useRef<Omit<Scene, 'now' | 'view' | 'duration'> & { follow: boolean }>({
    doc,
    shown,
    mapped,
    showOrig,
    sel,
    playing: playingCue,
    cpCur,
    scores,
    speech,
    peaks,
    follow,
  });
  sceneRef.current = { doc, shown, mapped, showOrig, sel, playing: playingCue, cpCur, scores, speech, peaks, follow };
  const secondAtRef = useRef(secondAt);
  secondAtRef.current = secondAt;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  useEffect(() => {
    dirtyRef.current = true;
  });

  const shownCue = useRef(-2);
  const updateOverlay = useLatest((time: number) => {
    const s = sceneRef.current;
    let cur = -1;
    for (let i = 0; i < s.shown.length; i++) {
      const c = s.shown[i];
      if (c && !s.mapped[i]?.deleted && time >= c.start && time < c.end) {
        cur = i;
        break;
      }
    }
    if (subRef.current && cur !== shownCue.current) {
      subRef.current.textContent = cur >= 0 ? displayText(s.mapped[cur]?.text ?? '') : '';
      shownCue.current = cur;
    }
    if (sub2Ref.current) {
      const two = secondAtRef.current(time);
      const text = two ? displayText(two) : '';
      if (sub2Ref.current.textContent !== text) sub2Ref.current.textContent = text;
    }
    if (cur !== s.playing) setPlayingCue(cur);
  });
  // Force the overlay to re-read the text after any change.
  useEffect(() => {
    shownCue.current = -2;
  });

  useEffect(() => {
    const readTheme = () => {
      paletteRef.current = readPalette();
      dirtyRef.current = true;
    };
    readTheme();
    const mo = new MutationObserver(readTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', readTheme);
    void document.fonts?.ready.then(readTheme);
    const ro = new ResizeObserver(() => {
      dirtyRef.current = true;
    });
    if (tlRef.current) ro.observe(tlRef.current);

    let raf = 0;
    let lastT = -1;
    let lastPlaying: boolean | null = null;
    let usingFrames = false;
    const frame = () => {
      const v = videoRef.current;
      const time = v?.currentTime ?? 0;
      const playing = !!v && !v.paused && !v.ended;
      if (rangeEnd.current != null && time >= rangeEnd.current) {
        v?.pause();
        rangeEnd.current = null;
      }
      if (playing !== lastPlaying) {
        setIsPlaying(playing);
        lastPlaying = playing;
      }
      if (time !== lastT || dirtyRef.current) {
        if (clockRef.current) clockRef.current.textContent = timecode(time);
        if (!(usingFrames && playing)) updateOverlay(time);
        const view = viewRef.current;
        const dur = durationRef.current;
        if (
          playing &&
          sceneRef.current.follow &&
          view.dur < dur &&
          (time < view.t0 || time > view.t0 + view.dur * 0.85)
        )
          setView(time + view.dur * 0.3, view.dur);
        const K = paletteRef.current;
        if (K) {
          const scene: Scene = { ...sceneRef.current, now: time, view: viewRef.current, duration: dur };
          if (tlRef.current) drawTimeline(tlRef.current, K, scene);
          if (ovRef.current) drawOverview(ovRef.current, K, scene);
        }
        lastT = time;
        dirtyRef.current = false;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // Lines on the picture follow the frames actually shown, when the browser can say which.
    let vfc = 0;
    const v = videoRef.current;
    type FrameVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    const fv = v as FrameVideo | null;
    if (fv?.requestVideoFrameCallback) {
      usingFrames = true;
      const onFrame = (_: number, meta: { mediaTime: number }) => {
        updateOverlay(meta.mediaTime);
        vfc = fv.requestVideoFrameCallback?.(onFrame) ?? 0;
      };
      vfc = fv.requestVideoFrameCallback(onFrame);
    }
    return () => {
      cancelAnimationFrame(raf);
      if (vfc) fv?.cancelVideoFrameCallback?.(vfc);
      mo.disconnect();
      mq.removeEventListener('change', readTheme);
      ro.disconnect();
    };
  }, [setView, updateOverlay]);

  /* ---------------------------------------------------------------- timeline pointer (docs/09, "時間軸") */

  type Drag =
    | { kind: 'scrub' }
    | { kind: 'offset'; k: number; hit: number; x0: number; pps: number; t: number; moved: boolean; before: SyncDoc }
    | {
        kind: 'cue';
        i: number;
        x0: number;
        pps: number;
        t: number;
        moved: boolean;
        before: SyncDoc;
        from: { dStart: number; dEnd: number };
      };
  const drag = useRef<Drag | null>(null);
  const point = (c: HTMLCanvasElement, e: ReactPointerEvent) => {
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
  };
  const cueAt = (time: number) => {
    for (let i = 0; i < mapped.length; i++) {
      const m = mapped[i];
      if (m && !m.deleted && time >= m.start && time <= m.end) return i;
    }
    return -1;
  };
  const onTlDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    const p = point(c, e);
    const view = viewRef.current;
    const pps = p.w / view.dur;
    const time = view.t0 + p.x / pps;
    c.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (!showOrig && p.y >= LANE_Y - 5 && p.y <= LANE_Y + LANE_H + 5) {
      const hit = cueAt(time);
      const before = docRef.current;
      if (mode === 'edit' && hit >= 0) {
        const ed = before.edits[String(cues[hit]?.id)] ?? {};
        drag.current = {
          kind: 'cue',
          i: hit,
          x0: p.x,
          pps,
          t: time,
          moved: false,
          before,
          from: { dStart: ed.dStart ?? 0, dEnd: ed.dEnd ?? 0 },
        };
      } else {
        const seg = hit >= 0 ? (mapped[hit]?.seg ?? 0) : segOf(before, sel);
        drag.current = { kind: 'offset', k: seg, hit, x0: p.x, pps, t: time, moved: false, before };
      }
    } else {
      drag.current = { kind: 'scrub' };
      rangeEnd.current = null;
      seek(time);
    }
  };
  const onTlMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e.currentTarget, e);
    if (d.kind === 'scrub') {
      seek(viewRef.current.t0 + p.x / (p.w / viewRef.current.dur));
      return;
    }
    const dx = p.x - d.x0;
    if (!d.moved && Math.abs(dx) < 3) return;
    const first = !d.moved;
    d.moved = true;
    const dt = Math.round((dx / d.pps) * 100) / 100;
    const next =
      d.kind === 'offset'
        ? setOffset(d.before, n, d.k, (d.before.segments[d.k]?.offset ?? 0) + dt)
        : moveLine(d.before, cues, d.i, d.from, dt);
    // One drag is one undo step.
    if (first) historyRef.current = record(historyRef.current, d.before);
    commit(next, { record: false });
  };
  const onTlUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.kind === 'scrub') return;
    if (!d.moved) {
      rangeEnd.current = null;
      seek(d.t);
      const hit = d.kind === 'cue' ? d.i : d.hit;
      if (hit >= 0) select(hit, true);
      return;
    }
    const cur = docRef.current;
    if (d.kind === 'offset') {
      const s = scoreOf(cur);
      say(t.bench.msg.dragged(signed(cur.segments[d.k]?.offset ?? 0), s == null ? null : pct(s)));
    } else {
      const m = SyncCore.applyDoc(cues, cur)[d.i];
      say(t.bench.msg.lineMoved(d.i + 1, shortTc(m?.start ?? 0)));
    }
  };
  const ovDown = useRef(false);
  const ovSeek = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = point(e.currentTarget, e);
    const time = Math.max(0, Math.min(duration, (p.x / p.w) * duration));
    rangeEnd.current = null;
    seek(time);
    if (viewRef.current.dur < duration) setView(time, viewRef.current.dur);
  };

  /* ---------------------------------------------------------------- render */

  const multi = doc.segments.length > 1;
  const [ra, rb] = segRange(doc, n, k);
  const seg = doc.segments[k] ?? { from: 0, scale: 1, offset: 0 };
  const rateId = SyncCore.RATES.find((r) => Math.abs(r.scale - seg.scale) < 1e-6)?.id ?? 'custom';
  const anchorsHere = doc.anchors.filter((a) => segOf(doc, a.cue) === k).length;
  const okCount = doc.checkpoints.filter((c) => c.status === 'ok').length;
  const edited = mapped.filter((c) => c.edited && !c.deleted).length;
  const deleted = mapped.filter((c) => c.deleted).length;
  const audioOnly = active?.kind === 'audio';
  const noSpeechReason = speech
    ? null
    : media?.analysis === 'pending' || media?.analysis === 'running'
      ? t.media.analysisPending
      : peaks
        ? t.media.speechMissing
        : media?.analysis === 'failed'
          ? t.media.analysisFailed(t.media.errors[media.errors.analysis ?? ''] ?? t.common.unknownError)
          : t.media.analysisNone;
  const fps = media?.fps ? t.bench.fps(String(Math.round(media.fps * 1000) / 1000)) : null;
  const info = [timecode(duration).slice(0, 8), torrent.version.videoCodec || null, fps, t.bench.cues(n)].filter(
    Boolean,
  );
  const saveText = removed
    ? null
    : saveState === 'saving'
      ? t.bench.save.saving
      : saveState === 'dirty'
        ? t.bench.save.dirty
        : saveState === 'failed'
          ? t.bench.save.failed
          : saveState === 'conflict'
            ? t.bench.save.conflict
            : t.bench.save.saved;
  const disabled = removed;

  const stage: ReactNode = (
    <div className="screen">
      {/* biome-ignore lint/a11y/useMediaCaption: the subtitles being synced are drawn over the picture */}
      <video
        ref={videoRef}
        src={active?.url}
        playsInline
        preload="auto"
        onError={onMediaError}
        onLoadedMetadata={(e) => {
          setMediaDuration(e.currentTarget.duration || 0);
          e.currentTarget.playbackRate = speed;
          if (resumeAt.current) e.currentTarget.currentTime = resumeAt.current;
          dirtyRef.current = true;
        }}
        onSeeked={() => {
          dirtyRef.current = true;
        }}
      />
      {audioOnly && (
        <div className="audio-only" aria-hidden="true">
          <b>{torrent.movie.title}</b>
        </div>
      )}
      <div className="subs" aria-live="off">
        <span ref={subRef} />
        <span ref={sub2Ref} className="sub2" />
      </div>
      {audioOnly && <span className="tag corner">{t.media.audioOnlyTag}</span>}
      {showOrig && <span className="tag orig">{t.bench.origTag}</span>}
    </div>
  );

  const onDockKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = DOCK_TABS.indexOf(dock);
    const next = DOCK_TABS[(i + (e.key === 'ArrowRight' ? 1 : DOCK_TABS.length - 1)) % DOCK_TABS.length] ?? dock;
    e.preventDefault();
    e.stopPropagation();
    setDock(next);
    requestAnimationFrame(() => document.getElementById(`dock-${next}`)?.focus());
  };

  return (
    <div className="bench">
      <header className="bar">
        <ol className="steps" aria-label={t.bench.stepsLabel}>
          {t.bench.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <div className="bar-actions">
          <span className="meta mono">{info.join(' · ')}</span>
          {saveText && (
            <span className={`sub${saveState === 'failed' || saveState === 'conflict' ? ' warnt' : ''}`} role="status">
              {saveText}
            </span>
          )}
          <Chip tone={status === 'confirmed' ? 'ok' : ''}>
            {status === 'confirmed' ? t.bench.confirmed : t.bench.draft}
          </Chip>
          <button
            type="button"
            className="primary"
            disabled={confirming || disabled}
            onClick={() => void confirm(false)}
          >
            {confirming ? t.bench.confirming : t.bench.confirm}
          </button>
        </div>
      </header>

      {confirmError && (
        <p className="bad bench-ask-error" role="alert">
          {confirmError}
        </p>
      )}
      {askConfirm !== null && (
        <ConfirmAsk
          left={askConfirm}
          onConfirm={() => void confirm(true)}
          onListen={() => {
            setAskConfirm(null);
            cpNext();
          }}
          onCancel={() => setAskConfirm(null)}
        />
      )}

      {removed && <Banner tone="warn">{t.bench.msg.removedElsewhere}</Banner>}

      <div className="work">
        <div className="stage-col">
          <section className="stage" aria-label={t.bench.video}>
            {stage}
            {better && (
              <div className="banner info">
                <span>{t.media.proxyReadySwitch}</span>
                <button type="button" onClick={() => switchTo(better.kind)}>
                  {t.media.switchToProxy}
                </button>
              </div>
            )}
            {!active && !allFailed && <p className="sub">{t.media.nothingPlayable}</p>}
            {allFailed && <Banner tone="bad">{t.media.playbackFailed}</Banner>}
            <div className="transport">
              <button type="button" className="strong play" disabled={!active} onClick={togglePlay}>
                {isPlaying ? t.bench.pause : t.bench.play}
              </button>
              <button type="button" aria-label={t.bench.back1Label} onClick={() => seek(clock() - 1)}>
                {t.bench.back1}
              </button>
              <button type="button" aria-label={t.bench.fwd1Label} onClick={() => seek(clock() + 1)}>
                {t.bench.fwd1}
              </button>
              <span className="clock mono">
                <output ref={clockRef}>{timecode(0)}</output> <span className="dur">/ {timecode(duration)}</span>
              </span>
              <span className="push">
                <label className="chk">
                  {t.bench.speed}
                  <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                    {SPEEDS.map((s) => (
                      <option key={s} value={s}>
                        {`${s}×`}
                      </option>
                    ))}
                  </select>
                </label>
                {others.length > 0 && (
                  <>
                    <label className="chk">
                      <input type="checkbox" checked={secondOn} onChange={(e) => setSecondOn(e.target.checked)} />
                      {t.bench.second}
                    </label>
                    <label className="chk">
                      <span className="sr-only">{t.bench.secondPick}</span>
                      <select value={secondId ?? ''} disabled={!secondOn} onChange={(e) => setSecondId(e.target.value)}>
                        {others.map((s) => (
                          <option key={s.id} value={s.id}>
                            {langName(s.language)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </span>
            </div>
          </section>
          <div className="log" role="status" aria-live="polite">
            <Rich text={msg.text} />
            {msg.actions?.map((a) => (
              <button type="button" key={a.label} onClick={a.run}>
                {a.label}
              </button>
            ))}
          </div>

          <section className="dock" aria-label={t.bench.tools}>
            <div className="dock-tabs" role="tablist" aria-label={t.bench.tools} onKeyDown={onDockKey}>
              {DOCK_TABS.map((d) => (
                <button
                  key={d}
                  id={`dock-${d}`}
                  type="button"
                  role="tab"
                  aria-selected={dock === d}
                  aria-controls="dock-panel"
                  tabIndex={dock === d ? 0 : -1}
                  onClick={() => setDock(d)}
                >
                  {t.bench.dock[d]}
                  {d === 'checkpoints' && doc.checkpoints.length > 0 && (
                    <small className="mono">{`${okCount}/${doc.checkpoints.length}`}</small>
                  )}
                </button>
              ))}
            </div>
            <div id="dock-panel" className="dock-panel" role="tabpanel" aria-labelledby={`dock-${dock}`}>
              {dock === 'auto' && (
                <>
                  <div className="ctl">
                    <button
                      type="button"
                      className="strong"
                      disabled={!speech || aligning || disabled}
                      onClick={() => void auto()}
                    >
                      {aligning ? t.bench.auto.running : t.bench.auto.run}
                    </button>
                    <label className="chk">
                      <input type="checkbox" checked={allowSplit} onChange={(e) => setAllowSplit(e.target.checked)} />
                      {t.bench.auto.allowSplit}
                    </label>
                    <button type="button" disabled={!speech || disabled} onClick={snap}>
                      {t.bench.auto.snap}
                    </button>
                  </div>
                  <p>{noSpeechReason ?? t.bench.auto.note}</p>
                  {refPicked && (
                    <>
                      <div className="ctl">
                        <label className="chk grow ref-pick">
                          {t.bench.auto.byRef}
                          <select value={refPicked.id} onChange={(e) => setRefId(e.target.value)}>
                            {refChoices.map((s) => (
                              <option key={s.id} value={s.id}>
                                {t.bench.auto.refOption(langName(s.language), s.releaseName, s.status === 'confirmed')}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button type="button" disabled={aligning || disabled} onClick={() => void auto(refPicked.id)}>
                          {t.bench.auto.runByRef}
                        </button>
                      </div>
                      <p>{refPicked.status === 'confirmed' ? t.bench.auto.refNote : t.bench.auto.refDraftNote}</p>
                    </>
                  )}
                </>
              )}
              {dock === 'checkpoints' && (
                <>
                  <div className="ctl">
                    <button type="button" onClick={cpNext}>
                      {t.bench.checkpoints.next}
                    </button>
                    <span className="dots">
                      {doc.checkpoints.map((c, j) => (
                        <button
                          type="button"
                          key={c.cue}
                          className={`${c.status === 'ok' ? 'ok' : c.status === 'bad' ? 'bad' : ''}${j === cpCur ? ' cur' : ''}`}
                          aria-label={t.bench.checkpoints.dot(j + 1, c.cue + 1, t.bench.checkpoints.states[c.status])}
                          title={t.bench.checkpoints.dot(j + 1, c.cue + 1, t.bench.checkpoints.states[c.status])}
                          onClick={() => cpGo(j)}
                        >
                          {j + 1}
                        </button>
                      ))}
                    </span>
                    <span className="ctl-sep" aria-hidden="true" />
                    <button type="button" onClick={() => cpMark('ok')}>
                      {t.bench.checkpoints.ok}
                    </button>
                    <button type="button" onClick={() => cpMark('bad')}>
                      {t.bench.checkpoints.bad}
                    </button>
                  </div>
                  <p>{doc.checkpoints.length ? t.bench.checkpoints.help : t.bench.checkpoints.none}</p>
                </>
              )}
              {dock === 'offset' && (
                <>
                  <p className="dock-scope">
                    <span className="chip">
                      {multi ? t.bench.offset.scope(k + 1, ra + 1, rb) : t.bench.offset.whole}
                    </span>
                  </p>
                  <div className="ctl">
                    <button type="button" onClick={() => nudge(-0.5)}>
                      −500
                    </button>
                    <button type="button" onClick={() => nudge(-0.05)}>
                      −50
                    </button>
                    <input
                      className="mono offset"
                      inputMode="decimal"
                      aria-label={t.bench.offset.label}
                      value={offsetText}
                      onFocus={() => {
                        offsetFocused.current = true;
                      }}
                      onChange={(e) => setOffsetText(e.target.value)}
                      onBlur={() => {
                        offsetFocused.current = false;
                        applyOffsetText();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') applyOffsetText();
                      }}
                    />
                    <span>{t.bench.offset.unit}</span>
                    <button type="button" onClick={() => nudge(0.05)}>
                      +50
                    </button>
                    <button type="button" onClick={() => nudge(0.5)}>
                      +500
                    </button>
                  </div>
                  <div className="ctl">
                    <label className="chk grow">
                      {t.bench.offset.rate}
                      <select value={rateId} onChange={(e) => changeRate(e.target.value)}>
                        {SyncCore.RATES.map((r) => (
                          <option key={r.id} value={r.id}>
                            {(t.bench.rates[r.id] ?? r.id) + (r.scale === 1 ? '' : `（${rateText(r.scale)}）`)}
                          </option>
                        ))}
                        {rateId === 'custom' && (
                          <option value="custom">{t.bench.offset.custom(rateText(seg.scale))}</option>
                        )}
                      </select>
                    </label>
                  </div>
                </>
              )}
              {dock === 'anchors' && (
                <>
                  <div className="ctl">
                    <button type="button" onClick={anchor}>
                      {t.bench.anchors.anchor}
                    </button>
                    <button type="button" onClick={split}>
                      {t.bench.anchors.split}
                    </button>
                    {multi && k > 0 && (
                      <button type="button" onClick={merge}>
                        {t.bench.anchors.merge}
                      </button>
                    )}
                  </div>
                  {multi && (
                    <div className="chips">
                      {doc.segments.map((s, j) => {
                        const [a, b] = segRange(doc, n, j);
                        return (
                          <span key={s.from} className={`chip ${'abc'[j % 3]}${j === k ? ' cur' : ''}`}>
                            {t.bench.anchors.segChip(a + 1, b, signed(s.offset))}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <p>
                    {anchorsHere >= 2
                      ? t.bench.anchors.noteN(anchorsHere)
                      : anchorsHere === 1
                        ? t.bench.anchors.note1
                        : t.bench.anchors.note0}
                  </p>
                </>
              )}
              {dock === 'compare' && (
                <>
                  <div className="ctl">
                    <button
                      type="button"
                      onPointerDown={() => setOrig(true)}
                      onPointerUp={() => setOrig(false)}
                      onPointerLeave={() => setOrig(false)}
                      onPointerCancel={() => setOrig(false)}
                      onBlur={() => setOrig(false)}
                      onKeyDown={(e) => {
                        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) setOrig(true);
                      }}
                      onKeyUp={() => setOrig(false)}
                    >
                      {t.bench.compare.orig}
                    </button>
                    <button type="button" onClick={undo}>
                      {t.bench.compare.undo}
                    </button>
                    <button type="button" onClick={redo}>
                      {t.bench.compare.redo}
                    </button>
                    <button type="button" onClick={reset}>
                      {t.bench.compare.reset}
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>

        <section className="cues" aria-label={t.bench.listLabel}>
          <div className="cues-head">
            <input
              type="search"
              value={query}
              placeholder={t.bench.searchPlaceholder}
              aria-label={t.bench.searchPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
            />
            <fieldset className="switch">
              <legend className="sr-only">{t.bench.modeLabel}</legend>
              <button type="button" aria-pressed={mode === 'sync'} onClick={() => changeMode('sync')}>
                {t.bench.modeSync}
              </button>
              <button type="button" aria-pressed={mode === 'edit'} onClick={() => changeMode('edit')}>
                {t.bench.modeEdit}
              </button>
            </fieldset>
          </div>
          {sub.format === 'ass' && <p className="cue-note">{t.bench.assNote}</p>}
          <CueList
            shown={shown}
            mapped={mapped}
            second={secondTexts}
            scores={scores}
            query={query}
            sel={sel}
            playing={playingCue}
            isPlaying={isPlaying}
            reveal={reveal}
            mode={mode}
            onSelect={select}
            onSeek={(i: number) => {
              select(i);
              const m = mapped[i];
              if (!m) return;
              rangeEnd.current = null;
              seek(m.start);
              if (viewRef.current.dur < duration) setView(m.start, viewRef.current.dur);
            }}
            onPlayLine={(i: number) => {
              const m = mapped[i];
              if (m) playRange(m.start - 1, m.end + 0.4);
            }}
            onAnchor={anchor}
            onSplit={split}
            onEdit={onEdit}
            onText={onText}
            onTextFocus={onTextFocus}
          />
        </section>
      </div>

      <section className="timeline" aria-label={t.bench.timelineLabel}>
        <div className="tl-head">
          <div className="score">
            {t.bench.score}{' '}
            <strong className={score == null ? '' : scoreClass(score)}>{score == null ? '—' : pct(score)}</strong>{' '}
            <small>{t.bench.scoreNote}</small>
          </div>
          <div className="tl-tools">
            <button
              type="button"
              aria-label={t.bench.zoomOutLabel}
              onClick={() => setView(clock(), viewRef.current.dur * 2)}
            >
              {t.bench.zoomOut}
            </button>
            <button
              type="button"
              aria-label={t.bench.zoomInLabel}
              onClick={() => setView(clock(), viewRef.current.dur / 2)}
            >
              {t.bench.zoomIn}
            </button>
            <button type="button" onClick={() => setView(duration / 2, duration)}>
              {t.bench.zoomFit}
            </button>
            <label className="chk">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              {t.bench.follow}
            </label>
          </div>
        </div>
        {noSpeechReason && <p className="sub">{noSpeechReason}</p>}
        <canvas
          ref={ovRef}
          className="ov"
          role="img"
          aria-label={t.bench.overviewLabel}
          onPointerDown={(e) => {
            ovDown.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            ovSeek(e);
            e.preventDefault();
          }}
          onPointerMove={(e) => ovDown.current && ovSeek(e)}
          onPointerUp={() => {
            ovDown.current = false;
          }}
          onPointerCancel={() => {
            ovDown.current = false;
          }}
        />
        <canvas
          ref={tlRef}
          className="tl"
          role="img"
          aria-label={t.bench.timelineLabel}
          onPointerDown={onTlDown}
          onPointerMove={onTlMove}
          onPointerUp={onTlUp}
          onPointerCancel={onTlUp}
        />
        <ul className="legend">
          <li>
            <i className="k-wave" />
            {t.bench.legend.wave}
          </li>
          <li>
            <i className="k-speech" />
            {t.bench.legend.speech}
          </li>
          <li>
            <i className="k-a" />
            {t.bench.legend.segA}
          </li>
          <li>
            <i className="k-b" />
            {t.bench.legend.segB}
          </li>
          <li>{t.bench.legend.drag}</li>
        </ul>
      </section>

      {status === 'confirmed' && (
        <section className="summary" id="bench-summary" aria-label={t.bench.summary.title}>
          <h2>{t.bench.summary.title}</h2>
          <p>
            {t.bench.summary.line(score == null ? '—' : pct(score), okCount, doc.checkpoints.length, edited, deleted)}
          </p>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>{t.bench.summary.cols.seg}</th>
                  <th>{t.bench.summary.cols.lines}</th>
                  <th>{t.bench.summary.cols.rate}</th>
                  <th>{t.bench.summary.cols.offset}</th>
                </tr>
              </thead>
              <tbody>
                {doc.segments.map((s, j) => {
                  const [a, b] = segRange(doc, n, j);
                  return (
                    <tr key={s.from}>
                      <td>{multi ? t.bench.segLabel(j + 1) : t.bench.summary.whole}</td>
                      <td>{t.bench.summary.lines(a + 1, b)}</td>
                      <td className="mono">{rateText(s.scale)}</td>
                      <td className="mono">{`${signed(s.offset, 3)} ${t.bench.offset.unit}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="frow">
            <a className="btn" href={`/api/subtitles/${sub.id}/file?synced=true`} download>
              {t.bench.summary.download}
            </a>
            <Link className="btn strong" to={`/library/${torrent.id}/export`}>
              {t.bench.summary.toExport}
            </Link>
          </div>
        </section>
      )}

      <details className="keys">
        <summary>{t.bench.keys.title}</summary>
        <dl>
          {t.bench.keys.items.map(([ks, what]) => (
            <div key={what}>
              <dt>
                {ks.map((key, j) => (
                  <span key={key}>
                    {j > 0 && ' '}
                    <kbd>{key}</kbd>
                  </span>
                ))}
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

/** "Some checkpoints are not heard yet": asked next to the confirm button, focus on the answer. */
function ConfirmAsk({
  left,
  onConfirm,
  onListen,
  onCancel,
}: {
  left: number;
  onConfirm: () => void;
  onListen: () => void;
  onCancel: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="confirm bench-ask" role="alertdialog" aria-labelledby="bench-ask-text">
      <p id="bench-ask-text">
        <Rich text={t.bench.msg.pending(left)} />
      </p>
      <div className="frow">
        <button type="button" className="primary" ref={first} onClick={onConfirm}>
          {t.bench.msg.confirmAnyway}
        </button>
        <button type="button" onClick={onListen}>
          {t.bench.msg.listenNext}
        </button>
        <button type="button" onClick={onCancel}>
          {t.common.notNow}
        </button>
      </div>
    </div>
  );
}
