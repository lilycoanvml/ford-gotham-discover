'use client';

import { boardImageSrc } from '@/app/lib/boardImages';
import type { BoardState, Tile } from '@/app/frontend/lib/board';

/*
 * The board — Figma 1:10 (filling) and 1:146 (reveal).
 *
 * Nine slots on the same 165 / 15 / 63 column split the intro uses, except the
 * two blocks mirror each other: the narrow column sits right in the top block
 * and left in the lower one. That alternation is the whole rhythm of the
 * design, so it is built as two blocks rather than one uniform grid.
 *
 * Every slot is painted in its pastel from the first frame. Tiles fade content
 * in on top rather than appearing from nothing, so the composition never jumps
 * while someone is mid-sentence.
 */

function TileView({ tile, slot }: { tile: Tile; slot: string }) {
  if (tile.kind === 'image') {
    return (
      <img
        className={`board-tile board-${slot} is-filled`}
        src={boardImageSrc(tile.slug)}
        alt={tile.word}
      />
    );
  }
  if (tile.kind === 'word') {
    return (
      <span className={`board-tile board-${slot} is-filled board-word`}>
        {tile.word}
      </span>
    );
  }
  return <span className={`board-tile board-${slot}`} aria-hidden="true" />;
}

export default function DiscoveryBoard({
  board,
  showPersona = false,
}: {
  board: BoardState;
  /** The persona pill only carries its title once the reveal lands. */
  showPersona?: boolean;
}) {
  const { name, persona, tiles } = board;

  return (
    <div className="board">
      {/* Top block — narrow column on the RIGHT */}
      <div className="board-block board-block-a">
        <div className="board-col-wide">
          <span className={`board-tile board-name${name ? ' is-filled' : ''}`}>
            {name ?? ''}
          </span>
          <TileView tile={tiles.wide1} slot="wide" />
        </div>
        <TileView tile={tiles.tallRight} slot="tall" />
      </div>

      <TileView tile={tiles.full1} slot="full" />

      {/* Lower block — narrow column on the LEFT */}
      <div className="board-block board-block-c">
        <TileView tile={tiles.tallLeft} slot="tall" />
        <div className="board-col-wide">
          {/* Punctuation, not content. These never fill. */}
          <div className="board-dots" aria-hidden="true">
            <span className="board-dot board-dot-terra" />
            <span className="board-dot board-dot-steel" />
          </div>
          <TileView tile={tiles.wide2} slot="wide" />
        </div>
      </div>

      <span className={`board-tile board-persona${showPersona && persona ? ' is-filled' : ''}`}>
        {showPersona ? persona ?? '' : ''}
      </span>
    </div>
  );
}
