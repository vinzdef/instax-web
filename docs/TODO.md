# TODO

## Detect an un-ejected film cover

`PRINT_IMAGE` returns status `0xb2` when the pack's black cover sheet is still
in. Right now that surfaces as `refused with status 0xb2`, which tells the user
nothing.

Two steps, independent:

1. **Map `0xb2` to a hint.** Reactive, doable now. Word it as a likely cause,
   not a certainty — it has been observed exactly once, on one mini Link.
2. **Find a predictive flag.** `FILM_COUNT` (`SUPPORT_FUNCTION_INFO`
   sub-command 2) returns a byte whose low nibble is the shot count and whose
   high nibble is unknown. A cover flag plausibly lives there.

   Only sample captured so far, taken *after* ejecting on a mini Link:

   ```
   payload  a8 00 00 0b 00 00 00 00
   0xa8 = 0b1010_1000 → low nibble 8 shots, high nibble 0b1010 unknown
   ```

   Needs a matching capture from a fresh pack *before* ejecting, then diff.
   Shot count alone cannot work: a fresh pack reads 10 either way.

## Probe the unmodelled read opcodes

Read-only, cannot waste film. Send with an empty payload and dump via
`describeResponse`:

- `0x0000` version info
- `0x3010` additional printer info
- `0x3000` XYZ axis (the Link has a tilt sensor)
- `0x3080` print-head light correction info

Do not touch `0x2000`–`0x2081` (firmware) or `0x0101` (reset).

`0x8100`–`0x8108` (URL/audio upload, likely the "sound photo" QR feature) is
worth a look separately.

## Image byte budget

`prepareImage` caps at 60 KB, inherited from `instax-link-web`. `InstaxBLE`
uses 105 KB. If 105 is the real limit, every print is losing quality for no
reason. Untested either way — needs a hardware trial at increasing sizes.

## Verify square and wide film

Everything is confirmed on an INSTAX mini Link only. `chunkSize` differs for
square (1808 vs 900) and is unverified.

## Publish

Repo is local-only. Not on GitHub, not on npm.

## Fix README drift

Says "89 unit tests" (now 94). `ejectFilmCover()` is missing from the API
table. `ejectDelay` is documented but `settleDelay` was removed — check nothing
else references it.
