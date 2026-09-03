/*
 * The board's state and the rules that fill it.
 *
 * Figma 1:10 / 1:146. The board fills as the conversation runs and is complete
 * on the last answer, which is when the flow moves to the invite — there is no
 * separate reveal screen assembling a second version of it.
 *
 * Two of the nine slots are the solid pastel circles. They never take content;
 * they are the design's punctuation and they are drawn, not stored.
 */

/** The six slots that take a photo or a word from an answer. */
export type MediaSlot =
  'wide1' | 'tallLeft' | 'full1' | 'wide2' | 'tallRight' | 'full2';

export const MEDIA_SLOTS: readonly MediaSlot[] = [
  'wide1', 'tallLeft', 'full1', 'wide2', 'tallRight', 'full2',
];

export type Tile =
  | { kind: 'empty' }
  /** No photo honestly matched, so the tile carries the words instead. */
  | { kind: 'word'; word: string; imageAlt: string | null }
  | { kind: 'image'; slug: string; word: string };

export interface BoardState {
  name: string | null;
  tiles: Record<MediaSlot, Tile>;
}

export const emptyBoard = (): BoardState => ({
  name: null,
  tiles: {
    wide1:     { kind: 'empty' },
    tallLeft:  { kind: 'empty' },
    full1:     { kind: 'empty' },
    wide2:     { kind: 'empty' },
    tallRight: { kind: 'empty' },
    full2:     { kind: 'empty' },
  },
});

/*
 * Which slots each answer fills.
 *
 * `answers` counts the name first, so n=1 is the name and n=2..4 are the three
 * questions. The order is fixed in code rather than chosen by the model: the
 * composition then reads the same every run, and a slow match can never land a
 * tile in a slot a later answer already took.
 *
 * Two tiles per answer, evenly: the board is complete on the last answer and
 * then the flow moves on. The bottom full-width slot used to carry a persona
 * title; it is a content tile like any other now.
 */
const FILL_ORDER: Record<number, readonly MediaSlot[]> = {
  2: ['wide1', 'tallLeft'],
  3: ['full1', 'wide2'],
  4: ['tallRight', 'full2'],
};

export const slotsForAnswer = (n: number): readonly MediaSlot[] => FILL_ORDER[n] ?? [];

/** Slugs already on the board, so the matcher is never offered a repeat. */
export function takenSlugs(board: BoardState): string[] {
  return MEDIA_SLOTS
    .map(s => board.tiles[s])
    .filter((t): t is Extract<Tile, { kind: 'image' }> => t.kind === 'image')
    .map(t => t.slug);
}

export const imageCount = (board: BoardState): number =>
  MEDIA_SLOTS.filter(s => board.tiles[s].kind === 'image').length;

/*
 * The board must land on at least three photos.
 *
 * Honest matching is the priority while the conversation runs — a tile that
 * shows the wrong picture is worse than one showing the right word. But a board
 * made almost entirely of words reads as a failure of the idea rather than a
 * design, so once the last answer is in, word tiles are promoted to the closest
 * photo the matcher held in reserve until three are showing.
 *
 * Promotion runs in board order, so the tiles that fill first are the ones that
 * turn into photos, and the newest word survives as the mix the design wants.
 */
export const MIN_IMAGES = 3;

export function ensureMinimumImages(board: BoardState): BoardState {
  if (imageCount(board) >= MIN_IMAGES) return board;

  const tiles = { ...board.tiles };
  const used = new Set(takenSlugs(board));
  let have = imageCount(board);

  for (const slot of MEDIA_SLOTS) {
    if (have >= MIN_IMAGES) break;
    const tile = tiles[slot];
    if (tile.kind !== 'word' || !tile.imageAlt || used.has(tile.imageAlt)) continue;
    tiles[slot] = { kind: 'image', slug: tile.imageAlt, word: tile.word };
    used.add(tile.imageAlt);
    have += 1;
  }

  return { ...board, tiles };
}

export interface MatchFill {
  image: string | null;
  imageAlt: string | null;
  word: string;
}

/*
 * Ask the matcher what this answer should put on the board.
 *
 * Never throws and never rejects: the board is decoration on a live
 * conversation, so a failed match leaves the slots empty and Miles carries on
 * without a stall.
 */
export async function fetchFills(
  answer: string,
  count: number,
  taken: string[],
): Promise<MatchFill[]> {
  try {
    const res = await fetch('/api/board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, count, taken }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.fills) ? (data.fills as MatchFill[]) : [];
  } catch (err) {
    console.warn('[board] match failed', err);
    return [];
  }
}

/** Turn one matcher result into the tile it becomes. */
export const tileFor = (fill: MatchFill): Tile =>
  fill.image
    ? { kind: 'image', slug: fill.image, word: fill.word }
    : { kind: 'word', word: fill.word, imageAlt: fill.imageAlt };
