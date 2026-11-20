/**
 * Cutting text to a UTF-8 byte bound at a codepoint boundary. Node's
 * decoder answers a buffer whose tail dangles mid-codepoint with a
 * replacement character, and one replacement costs three bytes — a cap
 * that ignores the boundary stores a line up to two bytes over the
 * bound it was cut to. The byte caps in the tree (the log ring's line
 * cap, the transcript view's turn cap) cut through here, so a capped
 * line stays at or under its own bound.
 */

/**
 * `text` cut to at most `room` UTF-8 bytes, never splitting a
 * codepoint. Text already within the bound passes through untouched;
 * an over-bound cut that lands inside a multi-byte codepoint walks the
 * cut back to that codepoint's start, so the result decodes without
 * replacement characters and measures at or under `room`.
 */
export const capUtf8 = (text: string, room: number): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= room) {
    return text;
  }
  const cut = bytes.subarray(0, room);
  // The cut can land inside the buffer's last codepoint: walk back from
  // the cut over continuation bytes (10xxxxxx) — at most three, a lead
  // byte's tail — to the last codepoint's lead byte.
  let start = room - 1;
  while (start >= 0 && room - start <= 3 && (cut[start]! & 0xc0) === 0x80) {
    start -= 1;
  }
  if (start < 0) {
    // The walk fell off the buffer's head: the cut holds nothing but a
    // codepoint's dangling tail, and no byte of it decodes.
    return "";
  }
  const lead = cut[start]!;
  const need =
    (lead & 0x80) === 0
      ? 1
      : (lead & 0xe0) === 0xc0
        ? 2
        : (lead & 0xf0) === 0xe0
          ? 3
          : 4;
  // The lead declares the codepoint's length. Complete within the cut,
  // the walked-back bytes are that codepoint's own tail — keep them.
  // Otherwise the codepoint dangles past the cut: drop it, lead byte
  // included.
  return start + need <= room
    ? cut.toString("utf8")
    : cut.subarray(0, start).toString("utf8");
};
