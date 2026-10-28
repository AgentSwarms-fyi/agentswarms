// An effect's return value is its cleanup: React calls whatever comes back
// when the dependencies change or the component unmounts. An arrow with an
// expression body returns that expression, so `useEffect(() => el.scrollIntoView(...))`
// was harmless while scrollIntoView returned undefined, and crashed the page
// ("q is not a function", the whole route replaced by "Something went wrong")
// once Chromium's smooth scroll began returning a Promise. Enterprise
// Ontology's Ask tab did exactly that on the first question asked.
//
// The sweep: an effect with an expression body may only call something whose
// result is known to be undefined or a cleanup function. Calls that return a
// Promise, a handle or a number — scrolling, animation, timers, fetches, an
// async function — must sit in a braced body.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** `useEffect(() => <expr>, [deps])` with an expression (not braced) body. */
const EXPRESSION_EFFECT =
  /use(?:Layout)?Effect\(\s*\(\)\s*=>\s*(?=[^\s{])([\s\S]*?),\s*\[[^\]]*\]\s*,?\s*\)/g;

/** Calls whose result is not undefined and not a cleanup function. */
const RETURNS_A_VALUE =
  /\b(scrollIntoView|scrollTo|scrollBy|scroll|animate|play|requestAnimationFrame|setTimeout|setInterval|fetch|requestFullscreen|requestPointerLock|showPicker|then|catch|finally)\s*\(|\basync\b|\bawait\b|\bnew\s+/;

function expressionEffects(src: string): string[] {
  return [...src.matchAll(EXPRESSION_EFFECT)].map((m) => m[1].trim());
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("effects return only a cleanup or nothing", () => {
  it("finds expression-bodied effects, and flags the one that broke Ask", () => {
    const broken = `useEffect(
    () => bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }),
    [turns.length, busy],
  );`;
    const fine = `useEffect(() => setActive(0), [query]);`;
    const braced = `useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [n]);`;
    expect(expressionEffects(broken)).toHaveLength(1);
    expect(RETURNS_A_VALUE.test(expressionEffects(broken)[0])).toBe(true);
    expect(RETURNS_A_VALUE.test(expressionEffects(fine)[0])).toBe(false);
    expect(expressionEffects(braced)).toHaveLength(0);
    for (const bad of [
      "requestAnimationFrame(tick)",
      "setTimeout(go, 50)",
      "load().then(setRows)",
      "el.animate(frames, 200)",
      "window.scrollTo(0, 0)",
    ])
      expect(RETURNS_A_VALUE.test(bad), bad).toBe(true);
  });

  it("no effect in the app returns a scroll, animation, timer or promise", () => {
    const offenders: string[] = [];
    for (const p of sourceFiles("src")) {
      const src = readFileSync(p, "utf8");
      for (const expr of expressionEffects(src))
        if (RETURNS_A_VALUE.test(expr))
          offenders.push(`${p.split("\\").join("/")}: ${expr.slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });
});
