// Zod 4 compiles object parsers with `new Function` when it can, and finds
// out whether it can by trying `new Function("")`. The page's
// Content-Security-Policy refuses eval (R397), so the probe fails and Zod
// parses without the compiler, which is correct, but the browser reports the
// refused probe as a violation. In the R397 report-only trial it was the only
// report the home page raised. `jitless` skips the probe and gives the same
// results.
//
// Zod reads the setting when a schema is BUILT, and schemas are built at
// module scope, so this must run before any module that defines one. It is
// therefore the first import of both entry roots, src/router.tsx and
// src/start.ts; whichever the client evaluates first runs it. Browser only:
// the server has no policy to trip and keeps the compiled fast path.
//
// It is also the one file package.json lists under "sideEffects". The app
// declares none otherwise, and Rollup drops an import that is there only for
// its side effect: the first R397 build shipped without this call.
import { z } from "zod";

if (typeof document !== "undefined") z.config({ jitless: true });
