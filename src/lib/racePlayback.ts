import { useEffect, useMemo, useState } from "react";

export type RaceFrameLike = { frame: string };

/**
 * Where a bar race is in its playback, and whether it is running.
 *
 * FOUND IN R233. The reset was keyed on the frames ARRAY, which a `useMemo`
 * over `rows` rebuilds whenever the parent hands down a new array — and a
 * dashboard hands down a new array on every render, which an active filter, a
 * poll or a session refresh each cause. So a race jumped back to its first
 * frame for no reason the viewer could see, and a race they had PAUSED started
 * playing again.
 *
 * Keyed on the frames' own labels instead: the position is an index into the
 * frame list, so it stays meaningful exactly while that list does. An
 * identical series re-arriving changes nothing; a different one starts from
 * the beginning, as it should.
 *
 * The advance timer is keyed on the frame COUNT for the same reason. On the
 * array it restarted on every re-render, so a dashboard re-rendering faster
 * than `frameMs` left the race frozen on its first frame while it claimed to
 * be playing.
 */
export function useRacePlayback(
  frames: RaceFrameLike[],
  frameMs: number,
): {
  idx: number;
  playing: boolean;
  setIdx: (n: number | ((p: number) => number)) => void;
  setPlaying: (p: boolean | ((p: boolean) => boolean)) => void;
} {
  const key = useMemo(() => frames.map((f) => f.frame).join("\u0000"), [frames]);
  const count = frames.length;
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    setIdx(0);
    setPlaying(true);
  }, [key]);

  useEffect(() => {
    if (!playing || count <= 1) return;
    const t = setTimeout(() => setIdx((i) => (i + 1) % count), frameMs);
    return () => clearTimeout(t);
  }, [playing, idx, count, frameMs]);

  return { idx, playing, setIdx, setPlaying };
}
