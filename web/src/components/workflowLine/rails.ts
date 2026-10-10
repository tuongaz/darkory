import { laneTracks, railOf, tracks as railTracks, type LineTopology } from "./layout";
import { DONE_STATION, type LineConnector } from "./model";

/** A pair of neighbours on a rail: along a Connector, by hand, a gap no outcome runs along; `null` draws nothing (between two rows of the branch). */
export type Seg = { from: string; to: string; connector?: LineConnector; hand?: boolean } | null;

/**
 * What a line's rails are made of, from its topology alone: the main rail (from the start; the
 * Steps before it lead into "Also starts here"), its segments and tracks and the Connectors they
 * carry; the quiet line "When a Parent ends", its stations (Done last), segments and tracks.
 */
export function railParts(t: LineTopology) {
  const { lead, rail } = railOf(t);
  const mainTracks = railTracks(t);
  const mainSegs: Seg[] = rail.slice(0, -1).map((from, i) => {
    const s = t.segments.find((x) => x.from === from && x.to === rail[i + 1]);
    return s ? { from, to: s.to, connector: s.connector, hand: s.hand } : { from, to: rail[i + 1] };
  });
  const carried = new Set([...mainSegs.flatMap((s) => (s?.connector ? [s.connector.id] : [])), ...mainTracks.flatMap((k) => k.connectors.map((c) => c.id))]);
  const quietStations = [...t.rows.flatMap((r) => r.stations), DONE_STATION];
  const quietTracks = laneTracks(quietStations, t.rows.flatMap((r) => r.loops.map((l) => l.connector)), new Set());
  const lastRow = t.rows.at(-1);
  const quietSegs: Seg[] = quietStations.slice(0, -1).map((from, i) => {
    const to = quietStations[i + 1];
    const row = t.rows.find((r) => r.stations.includes(from))!;
    const k = row.stations.indexOf(from);
    if (to === DONE_STATION) return row.exit ? { from, to, connector: row.exit } : null;
    if (k === row.stations.length - 1) return null;
    const seg = row.segments.find((x) => x.lo === k);
    return { from, to, connector: seg?.connector };
  });
  return { lead, rail, mainTracks, mainSegs, carried, quietStations, quietTracks, quietSegs, lastRow };
}

